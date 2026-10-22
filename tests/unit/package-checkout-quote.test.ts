import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import { assertPackageCheckoutCurrent } from "../../src/modules/booking/package-checkout-binding.js";
import { packageCheckoutQuoteSchema } from "../../src/modules/booking/package-checkout-contract.js";
import { BusinessTravelSettingsModel } from "../../src/modules/business-travel-settings/business-travel-settings.model.js";
import { CHECK_TIME, checkoutFixture } from "../helpers/package-checkout-fixture.js";

describe("inactive read-only checkout preparation", () => {
  it("uses server package terms, canonical relationship peek and local card read only", async () => {
    const f = checkoutFixture();
    const quote = await f.prepare();
    expect(quote.payload.packageName).toBe(f.definition.name);
    expect(quote.payload.financials.bundlePriceCents).toBe(20000);
    expect(quote.payload.items[0]?.penaltyBasisCents).toBe(5000);
    expect(f.dependencies.relationships.peekClassification).toHaveBeenCalledWith(f.client);
    expect(f.dependencies.cards.getSavedCardStatus).toHaveBeenCalledTimes(1);
    expect(quote.payload.state).toBe("INTERNAL_UNRETAINED_NOT_ACCEPTED");
    expect(quote.payload).not.toHaveProperty("activationId");
  });
  it("preserves RETURNING0 and manual dues without copying legacy extras deposit", async () => {
    const f = checkoutFixture();
    f.client.set("financialRelationship", { state: "CONSUMED" });
    const quote = await f.prepare();
    expect(quote.payload.financials).toMatchObject({
      classification: "RETURNING",
      requiredUpfrontCents: 0,
      manualVenueDuesCents: 20500,
    });
    expect(quote.payload.financials.appointments.every((row) => row.upfrontCents === 0)).toBe(true);
  });
  it("permits zero bundle with independent positive basis but cash capacity0", async () => {
    const f = checkoutFixture();
    f.definition.bundlePriceCents = 0;
    const quote = await f.prepare();
    expect(quote.payload.penalty).toMatchObject({ soldBundlePriceCents: 0, lifetimeCapCents: 0 });
    expect(quote.payload.items[0]?.penaltyBasisCents).toBe(5000);
    expect(quote.payload.financials).toMatchObject({
      requiredUpfrontCents: 0,
      manualVenueDuesCents: 500,
    });
  });
  it.each([6, 12] as const)(
    "prepares FINITE%i with original activation-window guarantee and no fabricated purchase date",
    async (months) => {
      const f = checkoutFixture("FINITE");
      f.definition.set("contractTerms.validity.months", months);
      const quote = await f.prepare();
      expect(quote.payload.validity).toMatchObject({
        mode: "FINITE",
        months,
        calculationVersion: 1,
        guaranteeMethod: "CONSERVATIVE_GREGORIAN_OFFSET_ENVELOPE_V1",
      });
      expect(quote.payload).not.toHaveProperty("purchasedAt");
      expect(quote.payload.validity).not.toHaveProperty("purchasedAt");
    },
  );
  it("retains catalog finite-only version1 without upgrading it", async () => {
    const f = checkoutFixture("FINITE");
    f.definition.set("contractTerms", { version: 1, validityMonths: 6, penaltyPolicyVersion: 1 });
    expect((await f.prepare()).payload.definitionTerms).toEqual({
      version: 1,
      validityMonths: 6,
      penaltyPolicyVersion: 1,
    });
  });
  it("FOREVER has no synthetic deadline but still calls ordinary availability", async () => {
    const f = checkoutFixture();
    const quote = await f.prepare();
    expect(quote.payload.validity).toEqual({ mode: "FOREVER" });
    expect(f.dependencies.availability.getAvailability).toHaveBeenCalled();
    vi.spyOn(f.dependencies.availability, "getAvailability").mockResolvedValueOnce({
      businessId: String(f.business._id),
      serviceId: String(f.id(10)),
      timezone: "Asia/Dhaka",
      capacityMax: 1,
      days: [],
    });
    await expect(f.prepare()).rejects.toThrow("no longer available");
  });
  it("bounds reads to unique service/staff/day/context combinations instead of polling or querying per repeated row", async () => {
    const f = checkoutFixture();
    f.intent.selections.forEach((row) => {
      row.staffMembershipId = f.id(5);
      row.addonIds = [];
    });
    await f.prepare();
    expect(f.dependencies.services.findManyByIdsForBusiness).toHaveBeenCalledTimes(1);
    expect(f.dependencies.staff.listActiveByBusinessId).toHaveBeenCalledTimes(1);
    expect(f.dependencies.policies.findByBusinessId).toHaveBeenCalledTimes(1);
    expect(f.dependencies.readNoShowWindows).toHaveBeenCalledTimes(1);
    expect(f.dependencies.availability.getAvailability).toHaveBeenCalledTimes(3);
    expect(f.dependencies.booking.validateResponsibleStaff).toHaveBeenCalledTimes(3);
    expect(f.dependencies.booking.resolveAddonSnapshots).toHaveBeenCalledTimes(3);
    expect(f.dependencies.travel.findByBusinessId).not.toHaveBeenCalled();
  });
  it("preserves independent providers, times and add-ons", async () => {
    const f = checkoutFixture();
    const quote = await f.prepare();
    expect(
      new Set(quote.payload.appointments.map((row) => String(row.staffMembershipId))).size,
    ).toBe(2);
    expect(new Set(quote.payload.appointments.map((row) => row.startAt.toISOString())).size).toBe(
      6,
    );
    expect(quote.payload.appointments[0]?.addons[0]?.priceCents).toBe(500);
    expect(quote.payload.appointments[1]?.addons).toEqual([]);
  });
  it("prices different travel addresses independently and keeps their dues manual", async () => {
    const f = checkoutFixture();
    f.business.visitType = "TRAVEL_TO_CUSTOMER";
    f.intent.selections.forEach((row, index) => {
      row.travelAddress = {
        city: index % 2 ? "Nicosia" : "Larnaca",
        area: `Area${index}`,
        streetName: "Road",
        streetNumber: String(index + 1),
        propertyType: "Hotel",
      };
    });
    vi.spyOn(f.dependencies.travel, "findByBusinessId").mockResolvedValue(
      new BusinessTravelSettingsModel({
        businessId: f.business._id,
        cities: [
          { city: "Larnaca", active: true, feeCents: 200 },
          { city: "Nicosia", active: true, feeCents: 400 },
        ],
      }),
    );
    const quote = await f.prepare();
    expect(quote.payload.appointments.map((row) => row.travelFeeCents)).toEqual([
      200, 400, 200, 400, 200, 400,
    ]);
    expect(quote.payload.financials).toMatchObject({
      travelCents: 1800,
      requiredUpfrontCents: 3500,
      manualVenueDuesCents: 18800,
    });
    expect(f.dependencies.availability.requireServedCity).toHaveBeenCalled();
  });
  it.each([
    "stale-revision",
    "foreign-business",
    "foreign-customer",
    "foreign-service",
    "unknown-item",
    "inactive-service",
    "unassigned-provider",
    "zero-selected",
    "no-terms",
    "missing-P",
    "missing-proof",
    "unknown-address",
  ])("fails safely for %s", async (kind) => {
    const f = checkoutFixture("FINITE");
    const first = f.intent.selections[0];
    if (!first) throw new Error("Fixture");
    if (kind === "stale-revision") f.intent.expectedRevision = 3;
    if (kind === "foreign-business") f.definition.businessId = f.id(99);
    if (kind === "foreign-customer") f.client.linkedUserId = f.id(99);
    if (kind === "foreign-service") first.serviceId = f.id(99);
    if (kind === "unknown-item") first.definitionItemId = f.id(99);
    if (kind === "inactive-service") f.services[0]?.set("status", "INACTIVE");
    if (kind === "unassigned-provider") first.staffMembershipId = f.id(99);
    if (kind === "zero-selected") f.intent.selections = [];
    if (kind === "no-terms") f.definition.set("contractTerms", undefined);
    if (kind === "missing-P") f.definition.set("items.0.penaltyBasisCents", undefined);
    if (kind === "missing-proof") f.seed.temporalProofRef = undefined;
    if (kind === "unknown-address")
      first.travelAddress = {
        city: "Larnaca",
        area: "Area",
        streetName: "Street",
        streetNumber: "1",
        propertyType: "Hotel",
      };
    await expect(f.prepare()).rejects.toThrow();
  });
  it("rejects context spoofing before any reads", async () => {
    const f = checkoutFixture();
    await expect(
      f.preparer.prepare({ ...f.context, actorUserId: new Types.ObjectId() }, f.intent, f.seed),
    ).rejects.toThrow("scope");
    expect(f.dependencies.businesses.findById).not.toHaveBeenCalled();
  });
  it("does not invent configured fee percentages or card acceptance", async () => {
    const f = checkoutFixture();
    vi.spyOn(f.dependencies.policies, "findByBusinessId").mockResolvedValue(null);
    vi.spyOn(f.dependencies.cards, "getSavedCardStatus").mockResolvedValue({ hasSavedCard: false });
    const quote = await f.prepare();
    expect(quote.payload.policy.cancellation).toBeNull();
    expect(quote.payload.savedCardStatus).toBe("MISSING");
    expect(quote.payload.disclosure.savedCardUseRequiresExplicitAcceptance).toBe(true);
  });
  it("uses edited admin category windows rather than Service category or lazy singleton creation", async () => {
    const f = checkoutFixture();
    vi.spyOn(f.dependencies, "readNoShowWindows").mockResolvedValue([
      { categoryKey: "BEAUTY_WELLNESS", opensAfterMinutes: 22, closesAfterMinutes: 144 },
    ]);
    expect((await f.prepare()).payload.policy.noShowWindow).toEqual({
      categoryKey: "BEAUTY_WELLNESS",
      opensAfterMinutes: 22,
      closesAfterMinutes: 144,
    });
  });
  it("detects changed Service, price, schedule and policy on a quote retry", async () => {
    const f = checkoutFixture();
    const retained = await f.prepare();
    f.definition.bundlePriceCents = 21000;
    await expect(
      f.prepare().then((fresh) => assertPackageCheckoutCurrent(retained, fresh, CHECK_TIME)),
    ).rejects.toThrow("facts changed");
    f.definition.bundlePriceCents = 20000;
    f.services[0]?.set("updatedAt", new Date(CHECK_TIME.getTime() + 1));
    await expect(
      f.prepare().then((fresh) => assertPackageCheckoutCurrent(retained, fresh, CHECK_TIME)),
    ).rejects.toThrow("facts changed");
    f.services[0]?.set("updatedAt", retained.payload.items[0]?.serviceUpdatedAt);
    f.configuredPolicy.noShowPercentage = 99;
    await expect(
      f.prepare().then((fresh) => assertPackageCheckoutCurrent(retained, fresh, CHECK_TIME)),
    ).rejects.toThrow("facts changed");
  });
  it("pins a UTC tie-broken origin and refuses changed schedule membership on retry", async () => {
    const f = checkoutFixture("FOREVER", 2);
    const first = f.intent.selections[0];
    const second = f.intent.selections[1];
    const firstSeed = f.seed.appointments[0];
    const secondSeed = f.seed.appointments[1];
    if (!first || !second || !firstSeed || !secondSeed) throw new Error("Fixture");
    second.startAt = first.startAt;
    firstSeed.bookingId = f.id(51);
    secondSeed.bookingId = f.id(50);
    const retained = await f.prepare();
    expect(retained.payload.originBookingId).toEqual(secondSeed.bookingId);
    first.startAt = new Date(first.startAt.getTime() - 60000);
    const fresh = await f.prepare();
    expect(() => assertPackageCheckoutCurrent(retained, fresh, CHECK_TIME)).toThrow(
      "facts changed",
    );
    expect(retained.payload.originBookingId).toEqual(secondSeed.bookingId);
  });
  it("rejects an initial selected start at the accepted finite lower bound", async () => {
    const f = checkoutFixture("FINITE", 1);
    const before = await f.prepare();
    const row = f.intent.selections[0];
    if (before.payload.validity.mode !== "FINITE" || !row) throw new Error("Fixture");
    row.startAt = before.payload.validity.guaranteedNotBeforeExpiry;
    await expect(f.prepare()).rejects.toThrow();
  });
  it("keeps a retained timezone snapshot stable and requires reacceptance after Business timezone edit", async () => {
    const f = checkoutFixture("FINITE");
    const retained = await f.prepare();
    f.business.timezone = "UTC";
    const fresh = await f.prepare();
    expect(() => assertPackageCheckoutCurrent(retained, fresh, CHECK_TIME)).toThrow(
      "facts changed",
    );
    expect(retained.payload.validity).toMatchObject({ timezone: "Asia/Dhaka" });
  });
  it("rejects mismatched add-on reads and missing travel pricing instead of fabricating authority", async () => {
    const f = checkoutFixture();
    vi.spyOn(f.dependencies.booking, "resolveAddonSnapshots").mockResolvedValue([
      { addonId: f.id(99), name: "Foreign", priceCents: 500 },
    ]);
    await expect(f.prepare()).rejects.toThrow("add-on membership");
    const travel = checkoutFixture();
    travel.business.visitType = "TRAVEL_TO_CUSTOMER";
    await expect(travel.prepare()).rejects.toThrow("Travel settings unavailable");
  });
  it("rejects quotes at expiry and propagated read failures instead of faking provider/slot readiness", async () => {
    const f = checkoutFixture();
    f.setTime(f.seed.expiresAt);
    await expect(f.prepare()).rejects.toThrow("expired");
    f.setTime(CHECK_TIME);
    vi.spyOn(f.dependencies.availability, "getAvailability").mockRejectedValue(
      new Error("unknown scheduling outcome"),
    );
    await expect(f.prepare()).rejects.toThrow("unknown scheduling");
  });
  it("requires explicit disclosure and cannot use the quote schema as a payment/activation API", async () => {
    const quote = (await checkoutFixture().prepare()).payload;
    for (const input of [
      { ...quote, paymentSucceeded: true },
      { ...quote, purchasedAt: CHECK_TIME },
      { ...quote, source: "MANUAL" },
      { ...quote, disclosure: undefined },
    ])
      expect(packageCheckoutQuoteSchema.safeParse(input).success).toBe(false);
  });
});
