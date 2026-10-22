import { Settings } from "luxon";
import { Types } from "mongoose";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPackageCheckoutAcceptance,
  assertPackageCheckoutCurrent,
  bindPackageCheckoutQuote,
  hashPackageCheckoutQuote,
  packageCheckoutEnvelopeSchema,
} from "../../src/modules/booking/package-checkout-binding.js";
import {
  packageCheckoutIntentSchema,
  packageCheckoutQuoteSchema,
  quotePackageCheckoutMoney,
  selectPackageFinancialOrigin,
} from "../../src/modules/booking/package-checkout-contract.js";
import {
  calculatePackageExpiryV1,
  prepareFinitePackageValidityV1,
  validatePackageActivationDeadline,
} from "../../src/modules/booking/package-checkout-validity.js";
import {
  CHECK_TIME,
  checkoutEvidence,
  checkoutFixture,
  checkoutIds,
  QUOTE_TIME,
} from "../helpers/package-checkout-fixture.js";

describe("independent selected batch and single origin", () => {
  it.each([1, 3, 6])(
    "accepts %i independent selections without duplicating item identity",
    async (count) => {
      const f = checkoutFixture("FOREVER", count);
      const quote = (await f.prepare()).payload;
      expect(quote.appointments).toHaveLength(count);
      expect(quote.items.map((item) => item.totalSessions)).toEqual([3, 2, 1]);
      expect(new Set(quote.appointments.map((row) => String(row.bookingId))).size).toBe(count);
      expect(
        new Set(
          quote.appointments.slice(0, Math.min(count, 3)).map((row) => String(row.packageItemId)),
        ).size,
      ).toBe(1);
    },
  );
  it("rejects zero appointments and unknown client financial controls", () => {
    const f = checkoutFixture();
    for (const input of [
      { ...f.intent, selections: [] },
      { ...f.intent, bundlePriceCents: 1 },
      { ...f.intent, classification: "RETURNING" },
      { ...f.intent, accepted: true },
      { ...f.intent, customerUserId: f.id(90) },
    ])
      expect(packageCheckoutIntentSchema.safeParse(input).success).toBe(false);
  });
  it.each([
    "duplicate-booking",
    "duplicate-selection",
    "foreign-item",
    "wrong-service",
    "excess-quantity",
    "wrong-principal",
    "wrong-origin",
    "repeated-base",
    "wrong-disclosure",
    "wrong-policy",
  ])("rejects %s", async (kind) => {
    const quote = (await checkoutFixture().prepare()).payload;
    const first = quote.appointments[0];
    if (!first) throw new Error("Fixture");
    const changed =
      kind === "duplicate-booking"
        ? { ...quote, appointments: [first, first] }
        : kind === "duplicate-selection"
          ? {
              ...quote,
              appointments: quote.appointments.map((row) => ({
                ...row,
                selectionId: first.selectionId,
              })),
            }
          : kind === "foreign-item"
            ? { ...quote, appointments: [{ ...first, packageItemId: new Types.ObjectId() }] }
            : kind === "wrong-service"
              ? { ...quote, appointments: [{ ...first, serviceId: new Types.ObjectId() }] }
              : kind === "excess-quantity"
                ? {
                    ...quote,
                    items: quote.items.map((item, index) =>
                      index === 0 ? { ...item, totalSessions: 2 } : item,
                    ),
                  }
                : kind === "wrong-principal"
                  ? {
                      ...quote,
                      items: quote.items.map((item) => ({ ...item, penaltyBasisCents: 5001 })),
                    }
                  : kind === "wrong-origin"
                    ? { ...quote, originBookingId: quote.appointments[1]?.bookingId }
                    : kind === "repeated-base"
                      ? {
                          ...quote,
                          financials: {
                            ...quote.financials,
                            appointments: quote.financials.appointments.map((row) => ({
                              ...row,
                              includedBaseCents: 20000,
                            })),
                          },
                        }
                      : kind === "wrong-disclosure"
                        ? {
                            ...quote,
                            disclosure: {
                              ...quote.disclosure,
                              purchaseDepositOffsetsPenalty: true,
                            },
                          }
                        : { ...quote, policy: { ...quote.policy, noShowResolutionMinutes: 89 } };
    expect(packageCheckoutQuoteSchema.safeParse(changed).success).toBe(false);
  });
  it("uses earliest UTC and ObjectId lexical tie-break independent of selection order", async () => {
    const f = checkoutFixture();
    const quote = (await f.prepare()).payload;
    expect(selectPackageFinancialOrigin([...quote.appointments].reverse())).toEqual(
      quote.originBookingId,
    );
    const a = quote.appointments[0];
    const b = quote.appointments[1];
    if (!a || !b) throw new Error("Fixture");
    expect(selectPackageFinancialOrigin([{ ...b, startAt: a.startAt }, a])).toEqual(a.bookingId);
    expect(() => selectPackageFinancialOrigin([])).toThrow();
  });
  it("quotes one FIRST deposit and keeps all sibling bases and upfront0", async () => {
    const quote = (await checkoutFixture().prepare()).payload;
    expect(quote.financials).toMatchObject({
      bundlePriceCents: 20000,
      addonsCents: 500,
      travelCents: 0,
      normalTotalCents: 20500,
      requiredUpfrontCents: 3500,
      manualVenueDuesCents: 17000,
      upfrontOwner: "PLATFORM_FEE",
    });
    expect(quote.financials.appointments.filter((row) => row.includedBaseCents > 0)).toHaveLength(
      1,
    );
    expect(quote.financials.appointments.filter((row) => row.upfrontCents > 0)).toHaveLength(1);
    expect(quote.penalty).toMatchObject({
      appointmentCapCents: 2500,
      lifetimeCapCents: 10000,
      noPurchaseDepositOffset: true,
    });
  });
  it.each([
    [0, 0],
    [1, 1],
    [499, 499],
    [500, 500],
    [1003, 500],
    [2500, 500],
    [10000, 2000],
    [20000, 3500],
    [Number.MAX_SAFE_INTEGER, 3500],
  ])("single deposit B%i ->%i", async (bundle, expected) => {
    const quote = (await checkoutFixture("FOREVER", 1).prepare()).payload;
    const appointments = quote.appointments.map((row) => ({
      ...row,
      addons: [],
      travelFeeCents: 0,
    }));
    expect(
      quotePackageCheckoutMoney(bundle, "FIRST", quote.originBookingId, appointments)
        .requiredUpfrontCents,
    ).toBe(expected);
    expect(
      quotePackageCheckoutMoney(bundle, "RETURNING", quote.originBookingId, appointments)
        .requiredUpfrontCents,
    ).toBe(0);
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity])(
    "rejects unsafe financial input %s",
    async (bundle) => {
      const quote = (await checkoutFixture().prepare()).payload;
      expect(() =>
        quotePackageCheckoutMoney(bundle, "FIRST", quote.originBookingId, quote.appointments),
      ).toThrow();
    },
  );
  it("rejects overlapping distinct bookings on the same exclusive staff", async () => {
    const quote = (await checkoutFixture().prepare()).payload;
    const first = quote.appointments[0];
    if (!first) throw new Error("Fixture");
    const second = { ...first, bookingId: new Types.ObjectId(), selectionId: new Types.ObjectId() };
    expect(
      packageCheckoutQuoteSchema.safeParse({ ...quote, appointments: [first, second] }).success,
    ).toBe(false);
  });
});

describe("retained quote content binding without fabricated acceptance", () => {
  it("hashes canonical keys and rejects payload tampering", async () => {
    const quote = await checkoutFixture().prepare();
    expect(
      hashPackageCheckoutQuote(Object.fromEntries(Object.entries(quote.payload).reverse())),
    ).toBe(quote.termsHash);
    expect(
      packageCheckoutEnvelopeSchema.safeParse({ ...quote, termsHash: "b".repeat(64) }).success,
    ).toBe(false);
    expect(Object.isFrozen(quote.payload.appointments)).toBe(true);
    expect(
      packageCheckoutEnvelopeSchema.safeParse({
        ...quote,
        payload: { ...quote.payload, originBookingId: new Types.ObjectId() },
      }).success,
    ).toBe(false);
    expect(quote.payload).not.toHaveProperty("purchasedAt");
    expect(quote.payload.providerState).toBe("NOT_DISPATCHED");
  });
  it("acceptance consistency requires exact existing evidence, actor, payload hash and item tuple", async () => {
    const f = checkoutFixture();
    const quote = await f.prepare();
    const evidence = checkoutEvidence(quote);
    const input = {
      retainedQuote: quote,
      freshQuote: quote,
      retainedEvidence: evidence,
      authenticatedActor: { userId: f.context.customerUserId, role: "CUSTOMER" as const },
      now: CHECK_TIME,
    };
    expect(assertPackageCheckoutAcceptance(input)).toBeUndefined();
    for (const retainedEvidence of [
      undefined,
      { setupIntentId: "seti_fake" },
      { ...evidence, acceptedTermsHash: "b".repeat(64) },
      { ...evidence, quoteId: f.id(99) },
      { ...evidence, items: [] },
      { ...evidence, acceptedAt: QUOTE_TIME, version: 2 },
    ])
      expect(() => assertPackageCheckoutAcceptance({ ...input, retainedEvidence })).toThrow();
    expect(() =>
      assertPackageCheckoutAcceptance({
        ...input,
        authenticatedActor: { userId: f.id(99), role: "CUSTOMER" },
      }),
    ).toThrow();
  });
  it("allows observation refresh only; changed financial/policy/schedule facts require reacceptance", async () => {
    const f = checkoutFixture();
    const quote = await f.prepare();
    const later = new Date(CHECK_TIME.getTime() + 1000);
    f.setTime(later);
    const refreshed = await f.prepare();
    expect(() => assertPackageCheckoutCurrent(quote, refreshed, later)).not.toThrow();
    const changed = bindPackageCheckoutQuote({ ...refreshed.payload, savedCardStatus: "MISSING" });
    expect(() => assertPackageCheckoutCurrent(quote, changed, later)).toThrow("facts changed");
    expect(() => assertPackageCheckoutCurrent(quote, refreshed, quote.payload.expiresAt)).toThrow(
      "expired",
    );
  });
  it("reordering a stable batch does not change the hash or pinned origin", async () => {
    const f = checkoutFixture();
    const first = await f.prepare();
    f.intent.selections.reverse();
    f.seed.items.reverse();
    f.seed.appointments.reverse();
    const second = await f.prepare();
    expect(second.termsHash).toBe(first.termsHash);
    expect(second.payload.originBookingId).toEqual(first.payload.originBookingId);
  });
  it("rejects a forged finite guarantee or estimate even when its basic ordering is plausible", async () => {
    const quote = (await checkoutFixture("FINITE").prepare()).payload;
    if (quote.validity.mode !== "FINITE") throw new Error("Fixture");
    for (const override of [
      {
        guaranteedNotBeforeExpiry: new Date(quote.validity.guaranteedNotBeforeExpiry.getTime() + 1),
      },
      { estimatedExpiresAt: new Date(quote.validity.estimatedExpiresAt.getTime() + 1) },
    ])
      expect(
        packageCheckoutQuoteSchema.safeParse({
          ...quote,
          validity: { ...quote.validity, ...override },
        }).success,
      ).toBe(false);
  });
});

describe("approved independent calendar/DST policy and whole-window bound", () => {
  const previousNow = Settings.now;
  afterEach(() => {
    Settings.now = previousNow;
  });
  it.each([
    ["2026-01-31T06:00:00.123Z", 6, "Asia/Dhaka", "2026-07-31T06:00:00.123Z"],
    ["2023-08-31T06:00:00.000Z", 6, "Asia/Dhaka", "2024-02-29T06:00:00.000Z"],
    ["2024-08-31T06:00:00.000Z", 6, "Asia/Dhaka", "2025-02-28T06:00:00.000Z"],
    ["2024-02-29T06:00:00.000Z", 12, "Asia/Dhaka", "2025-02-28T06:00:00.000Z"],
    ["2025-09-29T00:30:00.000Z", 6, "Europe/Nicosia", "2026-03-29T01:30:00.000Z"],
    ["2026-04-25T00:30:00.000Z", 6, "Europe/Nicosia", "2026-10-25T01:30:00.000Z"],
    ["2011-06-30T22:00:00.000Z", 6, "Pacific/Apia", "2011-12-30T21:00:00.000Z"],
  ] as const)("calculates %s +%i in %s", (purchase, months, zone, expected) => {
    expect(calculatePackageExpiryV1(new Date(purchase), months, zone).toISOString()).toBe(expected);
  });
  it.each(["2026-01-01T00:00Z", "2026-07-01T00:00Z"])(
    "later fold is independent of library clock %s",
    (now) => {
      Settings.now = () => new Date(now).getTime();
      expect(
        calculatePackageExpiryV1(new Date("2026-04-25T00:30Z"), 6, "Europe/Nicosia").toISOString(),
      ).toBe("2026-10-25T01:30:00.000Z");
    },
  );
  it("covers internal midnight/clamp discontinuity with a conservative full-window proof", () => {
    const a = new Date("2026-08-30T17:59:00Z"),
      b = new Date("2026-08-30T18:01:00Z");
    const first = calculatePackageExpiryV1(a, 6, "Asia/Dhaka"),
      later = calculatePackageExpiryV1(b, 6, "Asia/Dhaka");
    expect(later < first).toBe(true);
    const validity = prepareFinitePackageValidityV1({
      months: 6,
      timezone: "Asia/Dhaka",
      activationNotBefore: a,
      activationNotAfterExclusive: new Date("2026-08-30T18:05:00Z"),
      guaranteeProofRef: new Types.ObjectId(),
    });
    if (validity.mode !== "FINITE") throw new Error("Fixture");
    for (let t = a.getTime(); t < validity.activationNotAfterExclusive.getTime(); t += 1000)
      expect(
        calculatePackageExpiryV1(new Date(t), 6, "Asia/Dhaka") >=
          validity.guaranteedNotBeforeExpiry,
      ).toBe(true);
    expect(validity.guaranteedNotBeforeExpiry.getTime()).toBe(a.getTime() + 179 * 86400000);
  });
  it.each([
    "Asia/Dhaka",
    "Europe/Nicosia",
    "America/New_York",
    "Australia/Lord_Howe",
    "Pacific/Apia",
    "UTC",
  ])("bound holds across deterministic monthly fixtures in %s", (timezone) => {
    for (const months of [6, 12] as const)
      for (let month = 0; month < 12; month++) {
        const start = new Date(Date.UTC(2026, month, 28, 22, 59, 59, 999));
        const validity = prepareFinitePackageValidityV1({
          months,
          timezone,
          activationNotBefore: start,
          activationNotAfterExclusive: new Date(start.getTime() + 2 * 86400000),
          guaranteeProofRef: new Types.ObjectId(),
        });
        if (validity.mode !== "FINITE") throw new Error("Fixture");
        for (const delta of [0, 1, 60000, 86400000, 172799999])
          expect(
            calculatePackageExpiryV1(new Date(start.getTime() + delta), months, timezone) >=
              validity.guaranteedNotBeforeExpiry,
          ).toBe(true);
      }
  });
  it("checks real supplied activation window and strict scheduled-start cutoff without generating success", async () => {
    const quote = (await checkoutFixture("FINITE").prepare()).payload;
    const expiry = validatePackageActivationDeadline(quote.validity, CHECK_TIME, [
      new Date("2026-02-01T00:00Z"),
    ]);
    if (!expiry) throw new Error("Fixture");
    expect(
      validatePackageActivationDeadline(quote.validity, CHECK_TIME, [
        new Date(expiry.getTime() - 1),
      ]),
    ).toEqual(expiry);
    expect(() => validatePackageActivationDeadline(quote.validity, CHECK_TIME, [expiry])).toThrow();
    expect(() =>
      validatePackageActivationDeadline(quote.validity, quote.expiresAt, [new Date("2026-02-01Z")]),
    ).toThrow("outside");
    expect(
      validatePackageActivationDeadline({ mode: "FOREVER" }, CHECK_TIME, [new Date("2027-01-01Z")]),
    ).toBeUndefined();
    expect(() =>
      validatePackageActivationDeadline({ mode: "FOREVER" }, CHECK_TIME, [QUOTE_TIME]),
    ).toThrow();
  });
  it.each(["Invalid/Zone", "+06:00", "Z", " Asia/Dhaka "])(
    "rejects unsupported zone %s",
    (zone) => {
      expect(() => calculatePackageExpiryV1(CHECK_TIME, 6, zone)).toThrow();
    },
  );
  it("rejects missing/invalid activation dates and unversioned proof controls", () => {
    expect(() => calculatePackageExpiryV1(new Date(Number.NaN), 6, "UTC")).toThrow();
    expect(() =>
      prepareFinitePackageValidityV1({
        months: 6,
        timezone: "UTC",
        activationNotBefore: CHECK_TIME,
        activationNotAfterExclusive: QUOTE_TIME,
        guaranteeProofRef: new Types.ObjectId(),
      }),
    ).toThrow();
    expect(checkoutIds).toHaveLength(100);
  });
});
