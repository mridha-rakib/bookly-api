import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import { packageReservationPartySize } from "../../src/modules/booking/booking-package-foundation.js";
import { planPackageBatchMaterialization } from "../../src/modules/booking/package-batch-materialization.js";
import {
  assertPackageCheckoutCurrent,
  bindPackageCheckoutQuote,
} from "../../src/modules/booking/package-checkout-binding.js";
import { packageCheckoutQuoteSchema } from "../../src/modules/booking/package-checkout-contract.js";
import { buildPackageCheckoutDisclosure } from "../../src/modules/booking/package-checkout-disclosure.js";
import { packageCheckoutRetentionSchema } from "../../src/modules/booking/package-checkout-retention.js";
import { PackageProgressV2Model } from "../../src/modules/package-progress/package-progress-v2.model.js";
import {
  derivePackageProgressV2Totals,
  packageProgressV2InputSchema,
} from "../../src/modules/package-progress/package-progress-v2.rules.js";
import {
  packageGroupSeatSchema,
  resolvePackageServiceEntitlement,
} from "../../src/modules/packages/package-service-entitlement.js";
import { CHECK_TIME, checkoutFixture } from "../helpers/package-checkout-fixture.js";
import { prospectiveFixture } from "../helpers/package-v2-prospective-fixture.js";

const groupSeat = {
  version: 1 as const,
  unit: "ONE_SEAT" as const,
  credits: 1 as const,
  partySize: 1 as const,
  capacityMax: 5,
};
function groupFixture() {
  const f = checkoutFixture("FOREVER", 1);
  const service = f.services[0];
  if (!service) throw new Error("Missing fixture");
  service.set({
    pricingMode: "PER_PERSON",
    fixedPricing: undefined,
    perPersonPricing: {
      ratePerPersonCents: 9000,
      minPersons: 1,
      maxPersons: 5,
      durationMin: 60,
      bufferAfterMin: 25,
    },
  });
  vi.mocked(f.dependencies.availability.getAvailability).mockImplementation(async (input) => ({
    businessId: String(f.business._id),
    serviceId: input.serviceId,
    timezone: f.business.timezone,
    capacityMax: 5,
    days: [
      {
        date: input.fromDate,
        isOpen: true,
        slots: f.intent.selections.map((row) => ({
          startAt: row.startAt.toISOString(),
          endAt: new Date(row.startAt.getTime() + 85 * 60000).toISOString(),
          eligibleStaffMembershipIds: [String(row.staffMembershipId)],
          source: "AUTO" as const,
        })),
      },
    ],
  }));
  return { ...f, service };
}
const retained = (
  f: ReturnType<typeof groupFixture>,
  quote: Awaited<ReturnType<typeof f.prepare>>,
) =>
  packageCheckoutRetentionSchema.parse({
    version: 1,
    state: "INTERNAL_RETAINED_NOT_ACCEPTED",
    seed: f.seed,
    intent: f.intent,
    quote,
  });

describe("D1-G retained one-seat Package preparation", () => {
  it("preserves the exact pre-D1-G FIXED envelope digest", async () => {
    expect((await checkoutFixture().prepare()).termsHash).toBe(
      "5384a26e0068c4e721633407fb88cd35b934dcc39a64b59ab868154710d423cb",
    );
  });
  it("prepares an actual PER_PERSON Group without adding its ordinary price", async () => {
    const f = checkoutFixture("FOREVER", 1);
    const service = f.services[0];
    if (!service) throw new Error("Missing fixture Service");
    service.set({
      pricingMode: "PER_PERSON",
      fixedPricing: undefined,
      perPersonPricing: {
        ratePerPersonCents: 9000,
        minPersons: 1,
        maxPersons: 5,
        durationMin: 60,
        bufferAfterMin: 25,
      },
    });
    const original = f.dependencies.availability.getAvailability;
    vi.mocked(original).mockImplementation(async (input) => ({
      businessId: String(f.business._id),
      serviceId: input.serviceId,
      timezone: f.business.timezone,
      capacityMax: 5,
      days: [
        {
          date: input.fromDate,
          isOpen: true,
          slots: [
            {
              startAt: f.intent.selections[0]?.startAt.toISOString() ?? "",
              endAt: new Date(
                (f.intent.selections[0]?.startAt.getTime() ?? 0) + 85 * 60000,
              ).toISOString(),
              eligibleStaffMembershipIds: [String(f.providers[0]?._id)],
              source: "AUTO" as const,
            },
          ],
        },
      ],
    }));
    const quote = await f.prepare();
    expect(quote.payload.appointments[0]).toHaveProperty("group", {
      version: 1,
      unit: "ONE_SEAT",
      credits: 1,
      partySize: 1,
      capacityMax: 5,
    });
    expect(quote.payload.financials.bundlePriceCents).toBe(20000);
    expect(quote.payload.financials.normalTotalCents).toBe(20500);
  });

  it.each([
    "minPersons",
    "capacityOne",
    "capacityFraction",
    "duration",
    "negativeRate",
    "legacy",
    "hourly",
  ])("rejects unsupported %s source configuration", async (kind) => {
    const f = groupFixture();
    if (kind === "minPersons") f.service.set("perPersonPricing.minPersons", 2);
    if (kind === "capacityOne") f.service.set("perPersonPricing.maxPersons", 1);
    if (kind === "capacityFraction") f.service.set("perPersonPricing.maxPersons", 2.5);
    if (kind === "duration") f.service.set("perPersonPricing.durationMin", 0);
    if (kind === "negativeRate") f.service.set("perPersonPricing.ratePerPersonCents", -1);
    if (kind === "legacy") f.service.isPackageDeal = true;
    if (kind === "hourly") f.service.pricingMode = "HOURLY";
    expect(resolvePackageServiceEntitlement(f.service)).toBeUndefined();
    await expect(f.prepare()).rejects.toThrow();
  });
  it.each(["capacityMax", "partySize", "credits", "unit", "version"])(
    "hashes and rejects substituted %s",
    async (field) => {
      const f = groupFixture();
      const quote = await f.prepare();
      const changed = JSON.parse(JSON.stringify(quote.payload.appointments[0]?.group));
      changed[field] = field === "unit" ? "PARTY" : field === "capacityMax" ? 6 : 2;
      expect(packageGroupSeatSchema.safeParse(changed).success).toBe(field === "capacityMax");
      const candidate = {
        ...quote.payload,
        appointments: quote.payload.appointments.map((row) => ({ ...row, group: changed })),
      };
      expect(() => packageCheckoutQuoteSchema.parse(candidate)).toThrow();
      if (field === "capacityMax") {
        const fresh = bindPackageCheckoutQuote({
          ...candidate,
          items: quote.payload.items.map((row) => (row.group ? { ...row, group: changed } : row)),
        });
        expect(fresh.termsHash).not.toBe(quote.termsHash);
        expect(() => assertPackageCheckoutCurrent(quote, fresh, CHECK_TIME)).toThrow();
      }
    },
  );
  it.each(["staff", "service", "time", "business", "customer"])(
    "cannot adopt altered %s under retained identity",
    async (field) => {
      const f = groupFixture();
      const quote = await f.prepare();
      const payload = {
        ...quote.payload,
        appointments: quote.payload.appointments.map((row) => ({ ...row })),
      };
      const row = payload.appointments[0];
      if (!row) throw new Error("Missing row");
      if (field === "staff") row.staffMembershipId = f.id(6);
      if (field === "service") row.serviceId = f.id(11);
      if (field === "time") {
        row.startAt = new Date(row.startAt.getTime() + 60000);
        row.endAt = new Date(row.endAt.getTime() + 60000);
      }
      if (field === "business") payload.businessId = f.id(99);
      if (field === "customer") payload.customerUserId = f.id(99);
      expect(() => retained(f, bindPackageCheckoutQuote(payload))).toThrow();
    },
  );
  it("keeps proof and planner one-seat evidence stable on matching retry", async () => {
    const f = groupFixture();
    const q = await f.prepare();
    expect((await f.prepare()).termsHash).toBe(q.termsHash);
    const r = retained(f, q);
    const plan = planPackageBatchMaterialization({
      retention: r,
      claim: {
        idempotencyKey: f.seed.idempotencyKey,
        businessId: f.business._id,
        actorUserId: f.context.actorUserId,
        bookingId: q.payload.originBookingId,
      },
    });
    expect(plan.bookings[0]?.serviceLine.schedulingSnapshot.group).toEqual(groupSeat);
    expect(plan.progress.items[0]?.serviceSnapshot).toMatchObject({
      pricingMode: "PER_PERSON",
      group: groupSeat,
    });
    expect(plan.accountingSummary).toMatchObject({
      totalSessions: 6,
      remainingSessions: 5,
      scheduledSessions: 1,
    });
    const disclosure = buildPackageCheckoutDisclosure(r, f.id(90), [
      { staffMembershipId: f.id(5), displayName: "Provider" },
    ]);
    expect(disclosure.content.renderedTermsSnapshot).toContain("one person to one seat");
    expect(disclosure.content.renderedTermsSnapshot).toContain("original capacity 5");
  });
  it("rejects a full Group in advisory availability", async () => {
    const f = groupFixture();
    vi.mocked(f.dependencies.availability.getAvailability).mockResolvedValue({
      businessId: String(f.business._id),
      serviceId: String(f.service._id),
      timezone: f.business.timezone,
      capacityMax: 5,
      days: [],
    });
    await expect(f.prepare()).rejects.toThrow("no longer available");
  });
  it("preserves the same-Staff overlap prohibition even for identical Group slots", async () => {
    const f = groupFixture();
    const first = f.intent.selections[0];
    if (!first) throw new Error("Missing row");
    f.intent.selections.push({ ...first, selectionId: f.id(41) });
    f.seed.appointments.push({ selectionId: f.id(41), bookingId: f.id(51) });
    await expect(f.prepare()).rejects.toThrow();
  });
  it("does not accept posted capacity or party extensions in intent", async () => {
    const f = groupFixture();
    await expect(
      f.preparer.prepare(
        f.context,
        {
          ...f.intent,
          selections: f.intent.selections.map((row) => ({
            ...row,
            partySize: 2,
            group: groupSeat,
          })),
        },
        f.seed,
      ),
    ).rejects.toThrow();
  });
  it("validates mixed prospective accounting and rejects duplicate attempts", async () => {
    const f = groupFixture();
    const q = await f.prepare();
    const items = q.payload.items.map((item) => ({
      packageItemId: item.packageItemId,
      definitionItemId: item.definitionItemId,
      serviceId: item.serviceId,
      serviceSnapshot: item.group
        ? {
            name: item.serviceName,
            pricingMode: "PER_PERSON" as const,
            durationMin: item.baseDurationMin,
            group: item.group,
          }
        : {
            name: item.serviceName,
            pricingMode: "FIXED" as const,
            durationMin: item.baseDurationMin,
          },
      totalSessions: item.totalSessions,
      remainingSessions: item.totalSessions - (item.group ? 1 : 0),
      completedSessions: 0,
      referenceUnitPriceCents: item.referenceUnitPriceCents,
    }));
    const groupItem = items.find((item) => item.serviceSnapshot.pricingMode === "PER_PERSON");
    if (!groupItem) throw new Error("Missing Group");
    const input = prospectiveFixture(
      {
        _id: f.seed.packageProgressId,
        schemaVersion: 2,
        businessId: f.business._id,
        customerUserId: f.context.customerUserId,
        businessClientId: f.client._id,
        packageId: f.definition._id,
        originBookingId: q.payload.originBookingId,
        purchaseSnapshot: {
          name: f.definition.name,
          packageRevision: 4,
          bundlePriceCents: 20000,
          referenceTotalCents: 60000,
          discountPercent: 66.67,
          currency: "EUR",
          fulfilmentMode: "AT_BUSINESS_LOCATION",
        },
        items,
        sessions: [
          {
            bookingId: q.payload.originBookingId,
            packageItemId: groupItem.packageItemId,
            serviceId: groupItem.serviceId,
            status: "SCHEDULED",
          },
        ],
      },
      "FOREVER",
    );
    expect(input.items[0]).toMatchObject({ totalSessions: 3, remainingSessions: 2 });
    expect(derivePackageProgressV2Totals(input)).toMatchObject({
      totalSessions: 6,
      remainingSessions: 5,
      scheduledSessions: 1,
    });
    await expect(new PackageProgressV2Model(input).validate()).resolves.toBeUndefined();
    expect(
      packageProgressV2InputSchema.safeParse({
        ...input,
        sessions: [...input.sessions, ...input.sessions],
      }).success,
    ).toBe(false);
    expect(
      packageProgressV2InputSchema.safeParse({
        ...input,
        items: input.items.map((item) => ({
          ...item,
          serviceSnapshot: { ...item.serviceSnapshot, group: { ...groupSeat, partySize: 2 } },
        })),
      }).success,
    ).toBe(false);
  });
  it("resolves Package party explicitly without ordinary personCount", () => {
    const id = new Types.ObjectId();
    const line = {
      serviceSnapshot: { pricingMode: "PACKAGE" },
      pricingInput: { packageProgressId: id, packageItemId: id },
      packageContext: {
        packageId: id,
        packageName: "Bundle",
        definitionItemId: id,
        role: "PURCHASE" as const,
      },
      schedulingSnapshot: {
        version: 1 as const,
        baseDurationMin: 60,
        processingTimeMin: 0,
        bufferAfterMin: 25,
        occupiedDurationMin: 85,
        group: groupSeat,
      },
    };
    expect(packageReservationPartySize(line)).toBe(1);
    expect(() =>
      packageReservationPartySize({
        ...line,
        pricingInput: { ...line.pricingInput, personCount: 2 },
      }),
    ).toThrow();
  });
});
