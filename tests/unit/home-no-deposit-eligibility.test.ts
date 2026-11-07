import { Types } from "mongoose";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { newPurchaseReturningUpfrontCents } from "../../src/modules/booking/financial-contract.js";
import { BusinessModel } from "../../src/modules/business/business.model.js";
import { BusinessClientModel } from "../../src/modules/client/client.model.js";
import {
  createNoDepositEligibilityRoute,
  noDepositEligibilitySchema,
  readHomeNoDepositEligibility,
} from "../../src/modules/discovery/no-deposit-eligibility.js";
import { ServiceModel } from "../../src/modules/services/service.model.js";

const customer = String(new Types.ObjectId()),
  a = String(new Types.ObjectId()),
  b = String(new Types.ObjectId()),
  serviceId = String(new Types.ObjectId());
let rows: unknown[],
  available: string[],
  services: { _id: { businessId: string; serviceId: string | null } }[];
beforeEach(() => {
  available = [a, b];
  services = [{ _id: { businessId: a, serviceId } }, { _id: { businessId: b, serviceId: null } }];
  rows = [{ businessId: a, financialRelationship: { version: 2, state: "CONSUMED" } }];
  vi.spyOn(BusinessModel, "find").mockImplementation(
    () => ({ lean: () => ({ exec: async () => available.map((_id) => ({ _id })) }) }) as never,
  );
  vi.spyOn(BusinessClientModel, "find").mockImplementation(
    () => ({ exec: async () => rows }) as never,
  );
  vi.spyOn(ServiceModel, "aggregate").mockImplementation(
    () => ({ exec: async () => services }) as never,
  );
});
afterEach(() => vi.restoreAllMocks());
it("projects current RETURNING with guaranteed ordinary zero-upfront; FIRST elsewhere remains false", async () => {
  const result = await readHomeNoDepositEligibility(customer, [
    { businessId: a },
    { businessId: b },
    { businessId: a, serviceId },
  ]);
  expect(result).toEqual({
    scope: "NEW_ORDINARY_BOOKING",
    selections: [
      { businessId: a, noDepositNeeded: true },
      { businessId: b, noDepositNeeded: false },
      { businessId: a, serviceId, noDepositNeeded: true },
    ],
  });
  expect(newPurchaseReturningUpfrontCents("RETURNING")).toBe(0);
  expect(newPurchaseReturningUpfrontCents("FIRST")).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("financialRelationship");
});
it.each(["ELIGIBLE", "FIRST_PENDING", "RESTORATION_PENDING"])(
  "does not claim RETURNING for %s, regardless of old Bookings or zero price",
  async (state) => {
    rows = [{ businessId: a, financialRelationship: { state }, activatedAt: new Date() }];
    expect(
      (await readHomeNoDepositEligibility(customer, [{ businessId: a }])).selections[0]
        ?.noDepositNeeded,
    ).toBe(false);
  },
);
it("uses the established legacy activated marker only when no relationship state exists, and follows restoration", async () => {
  rows = [{ businessId: a, activatedAt: new Date() }];
  expect(
    (await readHomeNoDepositEligibility(customer, [{ businessId: a }])).selections[0]
      ?.noDepositNeeded,
  ).toBe(true);
  rows = [{ businessId: a, activatedAt: new Date(), financialRelationship: { state: "ELIGIBLE" } }];
  expect(
    (await readHomeNoDepositEligibility(customer, [{ businessId: a }])).selections[0]
      ?.noDepositNeeded,
  ).toBe(false);
});
it("deduplicates and constrains reads to authenticated Customer/requested Businesses and ordinary active services", async () => {
  await readHomeNoDepositEligibility(customer, [
    { businessId: a },
    { businessId: a },
    { businessId: a, serviceId },
  ]);
  expect(BusinessModel.find).toHaveBeenCalledOnce();
  expect(BusinessClientModel.find).toHaveBeenCalledOnce();
  expect(ServiceModel.aggregate).toHaveBeenCalledOnce();
  expect(BusinessClientModel.find).toHaveBeenCalledWith(
    {
      businessId: { $in: [a] },
      linkedUserId: new Types.ObjectId(customer),
      linkState: "LINKED",
      archivedAt: { $exists: false },
    },
    { businessId: 1, financialRelationship: 1, activatedAt: 1 },
  );
  expect(BusinessModel.find).toHaveBeenCalledWith(
    expect.objectContaining({
      status: { $in: ["APPROVED", "WARNING"] },
      publicVisible: { $ne: false },
    }),
    { _id: 1 },
  );
  expect(vi.mocked(ServiceModel.aggregate).mock.calls[0]?.[0]?.[0]).toMatchObject({
    $match: {
      status: "ACTIVE",
      isPackageDeal: false,
      pricingMode: { $in: ["FIXED", "HOURLY", "PER_PERSON"] },
    },
  });
});
it("omits positive eligibility for unavailable Businesses and specific inactive/Package/foreign services", async () => {
  available = [];
  expect(
    (await readHomeNoDepositEligibility(customer, [{ businessId: a }])).selections[0]
      ?.noDepositNeeded,
  ).toBe(false);
  available = [a];
  services = [];
  expect(
    (await readHomeNoDepositEligibility(customer, [{ businessId: a, serviceId }])).selections[0]
      ?.noDepositNeeded,
  ).toBe(false);
});
it("rejects unbounded or actor-supplied payloads and mounts authenticated Customer-only middleware", () => {
  expect(
    noDepositEligibilitySchema.safeParse({ customerId: customer, selections: [{ businessId: a }] })
      .success,
  ).toBe(false);
  expect(
    noDepositEligibilitySchema.safeParse({
      selections: Array.from({ length: 61 }, () => ({ businessId: a })),
    }).success,
  ).toBe(false);
  const route = createNoDepositEligibilityRoute().stack.find(
    (layer) => layer.route?.path === "/no-deposit-eligibility",
  )?.route;
  expect((route as unknown as { methods: { get: boolean } })?.methods.get).toBe(true);
  expect(route?.stack).toHaveLength(5);
  const next = vi.fn();
  route?.stack[1]?.handle({ auth: { status: "SUSPENDED" } } as never, {} as never, next);
  expect(next).toHaveBeenLastCalledWith(expect.objectContaining({ statusCode: 403 }));
  route?.stack[2]?.handle({ auth: { role: "BUSINESS_OWNER" } } as never, {} as never, next);
  expect(next).toHaveBeenLastCalledWith(expect.objectContaining({ statusCode: 403 }));
});
