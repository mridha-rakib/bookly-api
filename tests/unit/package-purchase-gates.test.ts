import { Types } from "mongoose";
import { expect, it } from "vitest";
import { packageCheckoutHttpView } from "../../src/modules/booking/package-checkout-http-view.js";
import { packageCheckoutRetentionSchema } from "../../src/modules/booking/package-checkout-retention.js";
import { assessConsentCommitDeadline } from "../../src/modules/booking/package-consent-commit-deadline.js";
import { PackagePurchaseService } from "../../src/modules/booking/package-purchase.service.js";
import {
  verifyPackagePurchaseConsentCertification,
  verifyPackagePurchaseProductionCompletion,
} from "../../src/modules/booking/package-purchase-authority.js";
import {
  PackagePurchaseHttpController,
  purchaseHttpBodySchema,
} from "../../src/modules/booking/package-purchase-http.js";
import { checkoutFixture } from "../helpers/package-checkout-fixture.js";

it("production purchase, status and direct controller entry deny before dependencies", async () => {
  const untouched = new Proxy({} as never, {
    get() {
      throw Error("dependency touched");
    },
  });
  const service = new PackagePurchaseService(untouched, untouched);
  for (const action of [service.complete.bind(service), service.status.bind(service)])
    await expect(action(undefined, new Types.ObjectId(), "forged")).rejects.toMatchObject({
      code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE",
    });
  await expect(
    new PackagePurchaseHttpController(untouched).execute({} as never, {} as never),
  ).rejects.toMatchObject({ code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE" });
});
it("neither an acceptance DTO nor synthetic batch completion is production authority", async () => {
  await expect(
    verifyPackagePurchaseConsentCertification({ certified: true } as never),
  ).rejects.toMatchObject({ statusCode: 503 });
  await expect(
    verifyPackagePurchaseProductionCompletion({} as never, {
      state: "PREPARATION_ONLY_COMPLETE_BATCH",
    }),
  ).rejects.toMatchObject({ statusCode: 503 });
});
it("posted trust, money, customer and session fields are rejected by purchase HTTP", () => {
  for (const key of [
    "certified",
    "clientSecret",
    "customerUserId",
    "businessClientId",
    "amountCents",
    "issuedAt",
    "sessionFamilyId",
  ])
    expect(
      purchaseHttpBodySchema.safeParse({
        businessId: "1".repeat(24),
        operationId: "5d185e09-0aa8-479c-b214-756d4b164490",
        [key]: true,
      }).success,
    ).toBe(false);
});
it("the original quote view keeps the exact issuance/hash/expiry and never certifies it", async () => {
  const f = checkoutFixture();
  const quote = await f.preparer.prepare(f.context, f.intent, f.seed);
  const retained = packageCheckoutRetentionSchema.parse({
    version: 1,
    state: "INTERNAL_RETAINED_NOT_ACCEPTED",
    seed: f.seed,
    intent: f.intent,
    quote,
  });
  const before = packageCheckoutHttpView(retained),
    after = packageCheckoutHttpView(retained);
  expect(after).toEqual(before);
  expect(after.issuedAt).toEqual(f.seed.issuedAt);
  expect(after.expiresAt).toEqual(f.seed.expiresAt);
  expect(after.termsHash).toBe(quote.termsHash);
  expect(after.certification).toBe("UNRESOLVED");
  expect(after.purchaseAvailable).toBe(false);
  expect(after).not.toHaveProperty("sessionFamilyId");
});
it("late, unknown and unapproved post-commit clocks never certify consent", () => {
  const q = 1_800_000,
    d = q + 1_800_000;
  const input = {
    retainedIssuedAtMs: q,
    retainedExpiresAtMs: d,
    issuanceAttestation: { authorityId: "synthetic", earliestMs: q, latestMs: q },
  };
  for (const latestMs of [d, d + 1])
    expect(
      assessConsentCommitDeadline(
        {
          ...input,
          postCommitObservation: { authorityId: "synthetic", earliestMs: latestMs, latestMs },
        },
        ["synthetic"],
      ).kind,
    ).toBe("UNRESOLVED");
  expect(assessConsentCommitDeadline(input, ["synthetic"]).kind).toBe("UNRESOLVED");
  expect(
    assessConsentCommitDeadline({
      ...input,
      postCommitObservation: { authorityId: "synthetic", earliestMs: q + 1, latestMs: q + 1 },
    }).kind,
  ).toBe("UNRESOLVED");
});
