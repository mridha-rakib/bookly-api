import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import { packageCheckoutAffirmativeActionSchema } from "../../src/modules/booking/package-checkout-acceptance.js";
import {
  bindPackageCheckoutQuote,
  hashCanonicalPackageCheckoutContent,
} from "../../src/modules/booking/package-checkout-binding.js";
import {
  assertPackageDisclosureMatches,
  buildPackageCheckoutDisclosure,
  packageCheckoutDisclosureSnapshotSchema,
} from "../../src/modules/booking/package-checkout-disclosure.js";
import { CHECK_TIME, checkoutFixture } from "../helpers/package-checkout-fixture.js";

const setup = async (mode: "FINITE" | "FOREVER" = "FOREVER", months: 6 | 12 = 6) => {
  const f = checkoutFixture(mode);
  if (mode === "FINITE") f.definition.set("contractTerms.validity.months", months);
  return {
    f,
    build: async () => {
      const retained = {
        version: 1,
        state: "INTERNAL_RETAINED_NOT_ACCEPTED",
        seed: f.seed,
        intent: f.intent,
        quote: await f.prepare(),
      };
      const disclosure = buildPackageCheckoutDisclosure(
        retained,
        f.id(75),
        f.providers.map((p, i) => ({ staffMembershipId: p._id, displayName: `Stylist ${i + 1}` })),
      );
      return { retained, disclosure, text: disclosure.content.renderedTermsSnapshot };
    },
  };
};

describe("versioned exact server disclosure, not consent", () => {
  it("renders the exact supported English snapshot", async () => {
    const { build } = await setup();
    const { text, disclosure } = await build();
    expect(text).toMatchSnapshot();
    expect(disclosure.content).toMatchObject({ version: 1, templateVersion: 1, locale: "en" });
    expect(text).toContain("Hair: 3 sessions");
    expect(text).toContain("Facial: 2 sessions");
    expect(text).toContain("Massage: 1 sessions");
    expect(text.match(/with Stylist /g)).toHaveLength(6);
  });
  it.each([6, 12] as const)(
    "labels FINITE%i calendar estimate/guarantee and strict authorization/start versus completion",
    async (months) => {
      const { build } = await setup("FINITE", months);
      const { text } = await build();
      expect(text).toContain(`FINITE${months}`);
      expect(text).toContain(
        `Exactly ${months} calendar months from the original successful purchase activation`,
      );
      expect(text).toContain("Estimated expiry (not the final purchase expiry)");
      expect(text).toContain("Guaranteed minimum expiry boundary (not before)");
      expect(text).toContain("both be strictly before expiry");
      expect(text).toContain("may complete after expiry");
    },
  );
  it("FOREVER does not fabricate an expiry", async () => {
    const { build } = await setup();
    const { text } = await build();
    expect(text).toContain("FOREVER. No Package-specific expiry");
    expect(text).not.toContain("Estimated expiry");
  });
  it("missing definition validity fails rather than becoming FOREVER", async () => {
    const { f, build } = await setup();
    f.definition.set("contractTerms", undefined);
    await expect(build()).rejects.toThrow();
  });
  it("retains independent P, reference comparison, caps and no deposit offset", async () => {
    const { build } = await setup();
    const { text } = await build();
    expect(text).toContain(
      "penalty basis per included session EUR 50.00. Reference price EUR 100.00",
    );
    expect(text).toContain("per appointment: EUR 25.00");
    expect(text).toContain("lifetime monetary cap: EUR 100.00");
    expect(text).toContain("FIRST Package deposit does not offset");
    expect(text).toContain("forfeit the included credit PLUS");
    expect(text).toContain(
      "possible contractual monetary assessment is not an actual provider charge",
    );
    expect(text).toContain("expiry alone never charges money");
  });
  it("zero bundle shows actual L0 despite positive item P", async () => {
    const { f, build } = await setup();
    f.definition.bundlePriceCents = 0;
    const { text } = await build();
    expect(text).toContain("penalty basis per included session EUR 50.00");
    expect(text).toContain("lifetime monetary cap: EUR 0.00");
    expect(text).toContain("no Package monetary penalty can be collected");
  });
  it.each(["FIRST", "RETURNING"])(
    "shows %s deposit, separate extras and manual normal dues",
    async (classification) => {
      const { f, build } = await setup();
      if (classification === "RETURNING")
        f.client.set("financialRelationship", { state: "CONSUMED" });
      const { text } = await build();
      expect(text).toContain(`Normal payment estimate: ${classification}`);
      expect(text).toContain(
        `upfront deposit EUR ${classification === "FIRST" ? "35.00" : "0.00"}`,
      );
      expect(text).toContain("Initial add-on dues: EUR 5.00. Initial travel dues: EUR 0.00");
      expect(text).toContain("not automatically collected from the saved card");
    },
  );
  it("shows configured free/percentage cancellation and category timing without charging", async () => {
    const { build } = await setup();
    const { text } = await build();
    expect(text).toContain("72 hours or more before the appointment: free cancellation");
    expect(text).toContain("24 hours to less than 72 hours before the appointment: 40%");
    expect(text).toContain("Business no-show percentage: 100%");
    expect(text).toContain("No-show eligibility timing for BEAUTY_WELLNESS");
    expect(text).toContain("Business cancellation does not impose a Customer");
  });
  it.each(["cancellation", "noShowWindow"])(
    "positive monetary disclosure fails closed without %s",
    async (missing) => {
      const { f, build } = await setup();
      if (missing === "cancellation")
        vi.mocked(f.dependencies.policies.findByBusinessId).mockResolvedValue(null);
      else
        vi.mocked(f.dependencies.readNoShowWindows).mockResolvedValue([
          { categoryKey: "BEAUTY_WELLNESS", opensAfterMinutes: 0, closesAfterMinutes: 0 },
        ]);
      await expect(build()).rejects.toThrow();
    },
  );
  it("missing monetary policy at L0 stays explicitly unconfigured", async () => {
    const { f, build } = await setup();
    f.definition.bundlePriceCents = 0;
    vi.mocked(f.dependencies.policies.findByBusinessId).mockResolvedValue(null);
    const { text } = await build();
    expect(text).toContain("not configured; no percentage is inferred");
  });
  it("rejects an absent category window in an otherwise valid positive-penalty quote", async () => {
    const { build } = await setup();
    const { retained, disclosure } = await build();
    const quote = bindPackageCheckoutQuote({
      ...retained.quote.payload,
      policy: { ...retained.quote.payload.policy, noShowWindow: null },
    });
    expect(() =>
      buildPackageCheckoutDisclosure(
        { ...retained, quote },
        disclosure.content.payloadId,
        disclosure.content.providers,
      ),
    ).toThrow("Configured cancellation/no-show disclosure required");
  });
  it("shows the evaluated half-price lifetime cap with exact cents", async () => {
    const { f, build } = await setup();
    f.definition.bundlePriceCents = 9999;
    expect((await build()).text).toContain("lifetime monetary cap: EUR 49.99");
  });
  it("separates quote hash from disclosure hash; rejects tampering even if rehashed", async () => {
    const { build } = await setup();
    const { retained, disclosure } = await build();
    expect(disclosure.content.quoteHash).toBe(retained.quote.termsHash);
    expect(disclosure.contentHash).not.toBe(retained.quote.termsHash);
    const content = { ...disclosure.content, renderedTermsSnapshot: "forged terms" };
    expect(
      packageCheckoutDisclosureSnapshotSchema.safeParse({
        content,
        contentHash: disclosure.contentHash,
      }).success,
    ).toBe(false);
    expect(() =>
      assertPackageDisclosureMatches(retained, {
        content,
        contentHash: hashCanonicalPackageCheckoutContent(content),
      }),
    ).toThrow("does not match");
  });
  it("rejects unsupported template versions and incomplete staff names", async () => {
    const { build } = await setup();
    const { retained, disclosure } = await build();
    expect(
      packageCheckoutDisclosureSnapshotSchema.safeParse({
        ...disclosure,
        content: { ...disclosure.content, templateVersion: 2 },
      }).success,
    ).toBe(false);
    expect(() => buildPackageCheckoutDisclosure(retained, new Types.ObjectId(), [])).toThrow();
  });
  it.each([
    { accepted: true },
    { acceptedAt: CHECK_TIME },
    { setupIntentId: "seti_fake" },
    { actorUserId: new Types.ObjectId() },
  ])("does not mistake %o for an affirmative action", (input) => {
    expect(packageCheckoutAffirmativeActionSchema.safeParse(input).success).toBe(false);
  });
});
