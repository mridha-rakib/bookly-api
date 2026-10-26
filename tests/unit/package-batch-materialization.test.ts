import { readFileSync } from "node:fs";
import net from "node:net";
import { Settings } from "luxon";
import mongoose, { Types } from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planPackageBatchMaterialization } from "../../src/modules/booking/package-batch-materialization.js";
import { bindPackageCheckoutQuote } from "../../src/modules/booking/package-checkout-binding.js";
import {
  type PackageCheckoutQuote,
  quotePackageCheckoutMoney,
} from "../../src/modules/booking/package-checkout-contract.js";
import { packageProgressV2InputSchema } from "../../src/modules/package-progress/package-progress-v2.rules.js";
import { checkoutFixture } from "../helpers/package-checkout-fixture.js";

/** Only deterministic synthetic read doubles; never consent, payment or activation evidence. */
const fixture = async (
  picks = [0, 3],
  price = 15000,
  classification: "FIRST" | "RETURNING" = "FIRST",
  mode: "FOREVER" | "FINITE" | "FINITE12" = "FOREVER",
) => {
  const f = checkoutFixture(mode === "FINITE12" ? "FINITE" : mode);
  if (mode === "FINITE12")
    f.definition.contractTerms = {
      version: 2,
      validity: { mode: "FINITE", months: 12 },
      penaltyPolicyVersion: 1,
    };
  f.definition.name = "Beauty Care Package";
  f.definition.bundlePriceCents = price;
  f.definition.items = f.definition.items.slice(0, 2);
  f.seed.items = f.seed.items.slice(0, 2);
  f.intent.selections = picks.map((index) => {
    const selection = f.intent.selections[index];
    if (!selection) throw new Error("Fixture selection");
    return selection;
  });
  f.seed.appointments = picks.map((index) => {
    const mapping = f.seed.appointments[index];
    if (!mapping) throw new Error("Fixture mapping");
    return mapping;
  });
  const prepared = await f.prepare();
  const payload = {
    ...prepared.payload,
    financials: quotePackageCheckoutMoney(
      price,
      classification,
      prepared.payload.originBookingId,
      prepared.payload.appointments,
    ),
  };
  return {
    retention: {
      version: 1 as const,
      state: "INTERNAL_RETAINED_NOT_ACCEPTED" as const,
      seed: f.seed,
      intent: f.intent,
      quote: bindPackageCheckoutQuote(payload),
    },
    claim: {
      idempotencyKey: payload.idempotencyKey,
      businessId: payload.businessId,
      actorUserId: payload.customerUserId,
      bookingId: payload.originBookingId,
    },
  };
};
type Input = Awaited<ReturnType<typeof fixture>>;
const withPayload = (input: Input, change: Record<string, unknown>) => ({
  ...input,
  retention: {
    ...input.retention,
    quote: { ...input.retention.quote, payload: { ...input.retention.quote.payload, ...change } },
  },
});
const repin = (input: Input, payload: PackageCheckoutQuote): Input => ({
  ...input,
  retention: {
    ...input.retention,
    seed: {
      ...input.retention.seed,
      appointments: payload.appointments.map(({ selectionId, bookingId }) => ({
        selectionId,
        bookingId,
      })),
    },
    intent: {
      ...input.retention.intent,
      selections: input.retention.intent.selections.map((row) => {
        const appointment = payload.appointments.find((a) => a.selectionId.equals(row.selectionId));
        if (!appointment) throw new Error("Fixture appointment");
        return {
          ...row,
          startAt: appointment.startAt,
          staffMembershipId: appointment.staffMembershipId,
        };
      }),
    },
    quote: bindPackageCheckoutQuote(payload),
  },
  claim: { ...input.claim, bookingId: payload.originBookingId },
});
const frozenInput = (value: unknown): void => {
  if (value && typeof value === "object" && !(value instanceof Types.ObjectId)) {
    for (const child of Object.values(value)) frozenInput(child);
    Object.freeze(value);
  }
};
const originalLuxonNow = Settings.now;
afterEach(() => {
  vi.restoreAllMocks();
  Settings.now = originalLuxonNow;
});

describe("pure retained Package batch materialization (not activation)", () => {
  it("T1 maps one appointment to one Booking/attempt without phantom unused bookings", async () => {
    const input = await fixture([0]);
    const plan = planPackageBatchMaterialization(input);
    expect(plan.bookings).toHaveLength(1);
    expect(plan.progress.sessions).toHaveLength(1);
    expect(plan.accountingSummary.remainingSessions).toBe(4);
    expect(plan.bookings[0]?.bookingId).toBe(
      input.retention.seed.appointments[0]?.bookingId.toHexString(),
    );
  });
  it("T2/T18 expands Hair3 Facial2 into two Bookings, three remaining credits and one Progress", async () => {
    const input = await fixture();
    const plan = planPackageBatchMaterialization(input);
    expect(plan.bookings).toHaveLength(2);
    expect(plan.progress.packageProgressId).toBe(
      input.retention.seed.packageProgressId.toHexString(),
    );
    expect(plan.accountingSummary).toEqual({
      totalSessions: 5,
      remainingSessions: 3,
      scheduledSessions: 2,
      completedSessions: 0,
      forfeitedSessions: 0,
      expiredSessions: 0,
    });
    expect(plan.progress.items.map((item) => [item.totalSessions, item.remainingSessions])).toEqual(
      [
        [3, 2],
        [2, 1],
      ],
    );
    for (const item of plan.progress.items) {
      const attempts = plan.progress.sessions.filter(
        (row) => row.packageItemId === item.packageItemId,
      );
      expect(item.totalSessions).toBe(
        item.remainingSessions + attempts.length + item.completedSessions + item.expiredSessions,
      );
      expect(item).not.toHaveProperty("scheduledSessions");
      expect(
        attempts.every((row) => row.status === "SCHEDULED" && row.serviceId === item.serviceId),
      ).toBe(true);
    }
  });
  it("T3 distinguishes repeated Service sessions and independent Staff/time", async () => {
    const plan = planPackageBatchMaterialization(await fixture([0, 1]));
    expect(new Set(plan.bookings.map((row) => row.bookingId)).size).toBe(2);
    expect(new Set(plan.bookings.map((row) => row.serviceLine.serviceId)).size).toBe(1);
    expect(
      new Set(plan.bookings.map((row) => row.serviceLine.responsibleStaffMembershipId)).size,
    ).toBe(2);
    expect(new Set(plan.bookings.map((row) => row.schedule.startAt)).size).toBe(2);
    expect(plan.progress.items[0]?.remainingSessions).toBe(1);
  });
  it("T4 accepts all included quantities exactly", async () => {
    const plan = planPackageBatchMaterialization(await fixture([0, 1, 2, 3, 4]));
    expect(plan.bookings).toHaveLength(5);
    expect(plan.accountingSummary.remainingSessions).toBe(0);
  });
  it.each([
    "excess quantity",
    "no appointments",
    "duplicate selection",
    "duplicate Booking",
    "unknown item",
    "wrong Service",
    "missing Booking",
    "wrong package",
    "wrong business",
    "conflicting money",
    "overlap",
    "invalid duration",
  ])("T5–T9/T23 rejects %s in retained facts", async (kind) => {
    const input = await fixture([0, 1]);
    const q = input.retention.quote.payload;
    const first = q.appointments[0];
    if (!first) throw new Error("Fixture");
    const changed =
      kind === "excess quantity"
        ? { items: q.items.map((item, i) => (i === 0 ? { ...item, totalSessions: 1 } : item)) }
        : kind === "no appointments"
          ? { appointments: [] }
          : kind === "wrong package"
            ? { packageId: input.retention.seed.quoteId }
            : kind === "wrong business"
              ? { businessId: input.retention.seed.quoteId }
              : kind === "conflicting money"
                ? { financials: { ...q.financials, requiredUpfrontCents: 1 } }
                : {
                    appointments: q.appointments.map((row, i) =>
                      i === 0
                        ? row
                        : {
                            ...row,
                            ...(kind === "duplicate selection"
                              ? { selectionId: first.selectionId }
                              : kind === "duplicate Booking"
                                ? { bookingId: first.bookingId }
                                : kind === "unknown item"
                                  ? { packageItemId: input.retention.seed.quoteId }
                                  : kind === "wrong Service"
                                    ? { serviceId: input.retention.seed.quoteId }
                                    : kind === "missing Booking"
                                      ? { bookingId: undefined }
                                      : kind === "invalid duration"
                                        ? { timing: { ...row.timing, occupiedDurationMin: 1 } }
                                        : {
                                            staffMembershipId: first.staffMembershipId,
                                            startAt: first.startAt,
                                            endAt: first.endAt,
                                          }),
                          },
                    ),
                  };
    expect(() => planPackageBatchMaterialization(withPayload(input, changed))).toThrow();
  });
  it("T10 uses the retained Facial November3 origin ahead of Hair November5/7", async () => {
    const input = await fixture([0, 3, 1]);
    const q = input.retention.quote.payload;
    const dates = ["2026-11-05T10:00:00Z", "2026-11-07T09:00:00Z", "2026-11-03T14:00:00Z"];
    const appointments = q.appointments.map((row, i) => {
      const date = dates[i];
      if (!date) throw new Error("Fixture date");
      const startAt = new Date(date);
      return {
        ...row,
        startAt,
        endAt: new Date(startAt.getTime() + row.timing.occupiedDurationMin * 60000),
      };
    });
    const origin = appointments[2];
    if (!origin) throw new Error("Fixture origin");
    const plan = planPackageBatchMaterialization(
      repin(input, {
        ...q,
        appointments,
        originBookingId: origin.bookingId,
        financials: quotePackageCheckoutMoney(15000, "FIRST", origin.bookingId, appointments),
      }),
    );
    expect(plan.identity.originBookingId).toBe(origin.bookingId.toHexString());
    expect(plan.bookings[0]?.serviceLine.serviceSnapshot.name).toBe("Facial");
  });
  it("T11 permits equal starts with different Staff and keeps the lower retained Booking ID", async () => {
    const input = await fixture();
    const q = input.retention.quote.payload;
    const first = q.appointments[0];
    if (!first) throw new Error("Fixture");
    const appointments = q.appointments.map((row) => ({
      ...row,
      startAt: first.startAt,
      endAt: first.endAt,
    }));
    const plan = planPackageBatchMaterialization(
      repin(input, {
        ...q,
        appointments,
        financials: quotePackageCheckoutMoney(15000, "FIRST", q.originBookingId, appointments),
      }),
    );
    expect(plan.identity.originBookingId).toBe(first.bookingId.toHexString());
    expect(plan.bookings.filter((row) => row.isFinancialOrigin)).toHaveLength(1);
  });
  it("T12 normalizes equivalent seed and intent ordering without rewriting the retained digest", async () => {
    const input = await fixture([0, 3, 1]);
    const reordered = {
      ...input,
      retention: {
        ...input.retention,
        seed: {
          ...input.retention.seed,
          items: [...input.retention.seed.items].reverse(),
          appointments: [...input.retention.seed.appointments].reverse(),
        },
        intent: {
          ...input.retention.intent,
          selections: [...input.retention.intent.selections].reverse(),
        },
      },
    };
    expect(planPackageBatchMaterialization(reordered)).toEqual(
      planPackageBatchMaterialization(input),
    );
  });
  it("canonicalizes plan ordering while retaining the exact order-sensitive quote digest", async () => {
    const input = await fixture([0, 1, 3]);
    const q = input.retention.quote.payload;
    const appointments = [...q.appointments].reverse();
    const equivalent = repin(input, {
      ...q,
      items: [...q.items].reverse(),
      appointments,
      financials: quotePackageCheckoutMoney(15000, "FIRST", q.originBookingId, appointments),
    });
    const original = planPackageBatchMaterialization(input);
    const reordered = planPackageBatchMaterialization(equivalent);
    expect(reordered.identity.termsHash).toBe(equivalent.retention.quote.termsHash);
    expect(reordered.identity.termsHash).not.toBe(original.identity.termsHash);
    expect({
      ...reordered,
      identity: { ...reordered.identity, termsHash: original.identity.termsHash },
    }).toEqual(original);
  });
  it("preserves independent duration, processing, buffer and manual scheduling facts", async () => {
    const input = await fixture();
    const q = input.retention.quote.payload;
    const facial = q.items[1];
    if (!facial) throw new Error("Fixture item");
    const appointments = q.appointments.map((row) =>
      row.packageItemId.equals(facial.packageItemId)
        ? {
            ...row,
            timing: {
              version: 1 as const,
              baseDurationMin: 45,
              processingTimeMin: 20,
              bufferAfterMin: 5,
              occupiedDurationMin: 70,
            },
            endAt: new Date(row.startAt.getTime() + 70 * 60000),
            schedulingSource: "MANUAL" as const,
          }
        : row,
    );
    const plan = planPackageBatchMaterialization(
      repin(input, {
        ...q,
        appointments,
        items: q.items.map((item) =>
          item.packageItemId.equals(facial.packageItemId) ? { ...item, baseDurationMin: 45 } : item,
        ),
      }),
    );
    const booking = plan.bookings.find(
      (row) => row.serviceLine.serviceId === facial.serviceId.toHexString(),
    );
    expect(booking?.serviceLine.schedulingSnapshot).toEqual({
      version: 1,
      baseDurationMin: 45,
      processingTimeMin: 20,
      bufferAfterMin: 5,
      occupiedDurationMin: 70,
    });
    expect(booking?.serviceLine.serviceSnapshot.durationMin).toBe(45);
    expect(booking?.schedulingObservation.source).toBe("MANUAL");
  });
  it("T13/T14 allocates the bundle/upfront once and no included sibling amounts", async () => {
    const plan = planPackageBatchMaterialization(await fixture([0, 1, 3]));
    expect(
      plan.bookings.reduce((sum, row) => sum + row.quotedAllocation.includedBaseCents, 0),
    ).toBe(15000);
    expect(plan.bookings.reduce((sum, row) => sum + row.quotedAllocation.upfrontCents, 0)).toBe(
      3000,
    );
    for (const row of plan.bookings.filter((row) => !row.isFinancialOrigin)) {
      expect(row.serviceLine.amountCents).toBe(0);
      expect(row.quotedAllocation.upfrontCents).toBe(0);
    }
  });
  it("T15 keeps sibling manual extras/travel distinct from zero included base", async () => {
    const input = await fixture();
    const q = input.retention.quote.payload;
    const addons = q.appointments[0]?.addons;
    if (!addons) throw new Error("Fixture");
    const travelAddress = {
      city: "Larnaca" as const,
      propertyType: "Apartment" as const,
      area: "Center",
      streetName: "Main",
      streetNumber: "1",
    };
    const appointments = q.appointments.map((row) => ({
      ...row,
      addons,
      travelFeeCents: 700,
      location: { mode: "TRAVEL_TO_CUSTOMER" as const, travelAddress },
    }));
    const withTravel = repin(
      {
        ...input,
        retention: {
          ...input.retention,
          intent: {
            ...input.retention.intent,
            selections: input.retention.intent.selections.map((row) => ({
              ...row,
              addonIds: addons.map((addon) => addon.addonId),
              travelAddress,
            })),
          },
        },
      },
      {
        ...q,
        appointments,
        financials: quotePackageCheckoutMoney(15000, "FIRST", q.originBookingId, appointments),
      },
    );
    const sibling = planPackageBatchMaterialization(withTravel).bookings.find(
      (row) => !row.isFinancialOrigin,
    );
    expect(sibling?.quotedAllocation).toMatchObject({
      includedBaseCents: 0,
      upfrontCents: 0,
      addonsCents: 500,
      travelCents: 700,
      manualVenueDuesCents: 1200,
    });
    expect(sibling?.serviceLine.addons[0]?.priceCents).toBe(500);
  });
  it.each([
    [0, 0],
    [100, 100],
    [1000, 500],
    [15000, 3000],
    [50000, 3500],
  ])(
    "T16 preserves quoted FIRST %ic -> %ic without classifying/charging",
    async (price, upfront) => {
      const plan = planPackageBatchMaterialization(await fixture([0, 3], price));
      expect(plan.quotedFinancials.requiredUpfrontCents).toBe(upfront);
      expect(plan.quotedFinancials.classificationAuthority).toBe(
        "RELATIONSHIP_ESTIMATE_REQUIRES_FINALIZE",
      );
    },
  );
  it("T17 preserves RETURNING zero without payment evidence", async () => {
    const plan = planPackageBatchMaterialization(await fixture([0, 3], 15000, "RETURNING"));
    expect(plan.bookings.every((row) => row.quotedAllocation.upfrontCents === 0)).toBe(true);
    expect(plan.quotedFinancials.upfrontOwner).toBe("NONE");
  });
  it("T19/T24 replays identically, preserves identities and does not mutate frozen input", async () => {
    const input = await fixture([0, 1, 3]);
    const before = JSON.stringify(input);
    frozenInput(input);
    const plan = planPackageBatchMaterialization(input);
    expect(planPackageBatchMaterialization(input)).toEqual(plan);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(plan.bookings[0]?.serviceLine)).toBe(true);
    expect(new Set(plan.bookings.map((row) => row.bookingId))).toEqual(
      new Set(input.retention.seed.appointments.map((row) => row.bookingId.toHexString())),
    );
  });
  it.each(["bookingId", "businessId", "actorUserId", "idempotencyKey"] as const)(
    "T20 rejects claim %s conflict",
    async (key) => {
      const input = await fixture();
      expect(() =>
        planPackageBatchMaterialization({
          ...input,
          claim: {
            ...input.claim,
            [key]: key === "idempotencyKey" ? "other" : input.retention.seed.quoteId,
          },
        }),
      ).toThrow();
    },
  );
  it.each(["seed mapping", "intent mapping", "seed item", "hash", "eligible provider"])(
    "rejects %s disagreement",
    async (kind) => {
      const input = await fixture();
      const r = input.retention;
      const changed =
        kind === "seed mapping"
          ? {
              seed: {
                ...r.seed,
                appointments: r.seed.appointments.map((row) => ({
                  ...row,
                  bookingId: r.seed.quoteId,
                })),
              },
            }
          : kind === "intent mapping"
            ? {
                intent: {
                  ...r.intent,
                  selections: r.intent.selections.map((row) => ({
                    ...row,
                    serviceId: r.seed.quoteId,
                  })),
                },
              }
            : kind === "seed item"
              ? { seed: { ...r.seed, items: r.seed.items.slice(1) } }
              : kind === "hash"
                ? { quote: { ...r.quote, termsHash: "0".repeat(64) } }
                : {
                    quote: bindPackageCheckoutQuote({
                      ...r.quote.payload,
                      items: r.quote.payload.items.map((item) => ({
                        ...item,
                        eligibleProviderIds: [r.seed.quoteId],
                      })),
                    }),
                  };
      expect(() =>
        planPackageBatchMaterialization({ ...input, retention: { ...r, ...changed } }),
      ).toThrow();
    },
  );
  it("T22 defers purchase time and has no finite expiry for FOREVER", async () => {
    const plan = planPackageBatchMaterialization(await fixture());
    expect(plan.progress).not.toHaveProperty("purchasedAt");
    expect(plan.progress).not.toHaveProperty("expiresAt");
    expect(plan.deferred).toContain("WINNING_ACTIVATION_EVENT_PURCHASED_AT_AND_FINAL_EXPIRY");
    expect(plan.retainedTerms.validityDisclosure).toEqual({ mode: "FOREVER" });
  });
  it.each(["FINITE", "FINITE12"] as const)(
    "M1/M2/M19/M20 %s preserves exact proof and preparation boundaries",
    async (mode) => {
      const input = await fixture([0, 3], 15000, "FIRST", mode);
      const before = JSON.stringify(input);
      frozenInput(input);
      const plan = planPackageBatchMaterialization(input);
      expect(plan.bookings).toHaveLength(2);
      expect(plan.progress.sessions).toHaveLength(2);
      expect(plan.accountingSummary).toEqual({
        totalSessions: 5,
        remainingSessions: 3,
        scheduledSessions: 2,
        completedSessions: 0,
        forfeitedSessions: 0,
        expiredSessions: 0,
      });
      expect(plan.retainedTerms.validityDisclosure).toEqual(
        JSON.parse(JSON.stringify(input.retention.quote.payload.validity)),
      );
      expect(plan.progress).not.toHaveProperty("purchasedAt");
      expect(plan.progress).not.toHaveProperty("expiresAt");
      expect(packageProgressV2InputSchema.safeParse(plan.progress).success).toBe(false);
      expect(plan.state).toBe("PREPARATION_ONLY_NOT_ACTIVATED");
      expect(plan.authority).toBe("UNVERIFIED_RETAINED_FACTS");
      expect(plan.bookings.filter((row) => row.isFinancialOrigin)).toHaveLength(1);
      expect(plan.bookings.reduce((sum, row) => sum + row.serviceLine.amountCents, 0)).toBe(15000);
      expect(plan.bookings.map((row) => row.bookingId).sort()).toEqual(
        input.retention.quote.payload.appointments.map((row) => row.bookingId.toHexString()).sort(),
      );
      expect(planPackageBatchMaterialization(input)).toEqual(plan);
      expect(JSON.stringify(input)).toBe(before);
      expect(Object.isFrozen(plan.retainedTerms.validityDisclosure)).toBe(true);
    },
  );
  it.each(["FINITE", "FINITE12"] as const)(
    "M3/M4/M5 %s supports single, repeated and all selected units",
    async (mode) => {
      for (const picks of [[0], [0, 1], [0, 1, 2, 3, 4]]) {
        const plan = planPackageBatchMaterialization(
          await fixture(picks, 15000, "RETURNING", mode),
        );
        expect(plan.bookings).toHaveLength(picks.length);
        expect(new Set(plan.progress.sessions.map((row) => row.bookingId)).size).toBe(picks.length);
        expect(plan.accountingSummary.remainingSessions).toBe(5 - picks.length);
        expect(plan.quotedFinancials.requiredUpfrontCents).toBe(0);
        for (const row of plan.bookings.filter((row) => !row.isFinancialOrigin))
          expect(row.serviceLine.amountCents).toBe(0);
      }
    },
  );
  it.each(["FOREVER", "FINITE", "FINITE12"] as const)(
    "T25 has no DB/network/clock/random work for %s",
    async (mode) => {
      const input = await fixture([0, 3], 15000, "FIRST", mode);
      const unexpected = () => {
        throw new Error("Side effect attempted");
      };
      vi.spyOn(mongoose, "connect").mockImplementation(unexpected);
      vi.spyOn(mongoose.Query.prototype, "exec").mockImplementation(unexpected);
      vi.spyOn(mongoose.Model.prototype, "save").mockImplementation(unexpected);
      vi.spyOn(net.Socket.prototype, "connect").mockImplementation(unexpected);
      vi.spyOn(globalThis, "fetch").mockImplementation(unexpected);
      vi.spyOn(Date, "now").mockImplementation(unexpected);
      vi.spyOn(Types.ObjectId, "generate").mockImplementation(unexpected);
      const luxonClock = vi.fn(unexpected);
      Settings.now = luxonClock;
      expect(planPackageBatchMaterialization(input).bookings).toHaveLength(2);
      expect(luxonClock).not.toHaveBeenCalled();
      expect(mongoose.connection.readyState).toBe(0);
      const source = readFileSync(
        new URL("../../src/modules/booking/package-batch-materialization.ts", import.meta.url),
        "utf8",
      );
      expect(source).not.toMatch(
        /Date\.now\(|new Date\(|new Types\.ObjectId\(|\.save\(|\.findOne\(|process\.env/,
      );
    },
  );
  it("T28 cannot serve as purchased Progress, consent, reservation or payment authority", async () => {
    const input = await fixture();
    const plan = planPackageBatchMaterialization(input);
    expect(plan.state).toBe("PREPARATION_ONLY_NOT_ACTIVATED");
    expect(plan.authority).toBe("UNVERIFIED_RETAINED_FACTS");
    expect(packageProgressV2InputSchema.safeParse(plan.progress).success).toBe(false);
    for (const row of plan.bookings) {
      expect(row).not.toHaveProperty("status");
      expect(row).not.toHaveProperty("reference");
      expect(row.serviceLine).not.toHaveProperty("reservationId");
    }
    for (const key of [
      "acceptedAt",
      "activation",
      "paymentIntentId",
      "financialContract",
      "businessClientId",
    ])
      expect(plan).not.toHaveProperty(key);
    expect(() => planPackageBatchMaterialization({ ...input, accepted: true })).toThrow();
  });
});
