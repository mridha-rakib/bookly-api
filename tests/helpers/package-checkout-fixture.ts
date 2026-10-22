import { Types } from "mongoose";
import { vi } from "vitest";
import type {
  PackageCheckoutIntent,
  PackageCheckoutSeed,
} from "../../src/modules/booking/package-checkout-contract.js";
import {
  PackageCheckoutQuotePreparer,
  type PackageCheckoutReadDependencies,
} from "../../src/modules/booking/package-checkout-quote.service.js";
import { BusinessModel } from "../../src/modules/business/business.model.js";
import {
  BusinessCancellationPolicyModel,
  cancellationTiers,
} from "../../src/modules/business-cancellation-policy/business-cancellation-policy.model.js";
import { BusinessClientModel } from "../../src/modules/client/client.model.js";
import { FinancialRelationshipService } from "../../src/modules/client/financial-relationship.service.js";
import { PackageModel } from "../../src/modules/packages/package.model.js";
import { ServiceModel } from "../../src/modules/services/service.model.js";
import { StaffMembershipModel } from "../../src/modules/staff/staff.model.js";

/** Pure synthetic read doubles; constructors validate no real purchase or DB state. */
export const checkoutIds = Array.from(
  { length: 100 },
  (_, index) => new Types.ObjectId((index + 1).toString(16).padStart(24, "0")),
);
export const QUOTE_TIME = new Date("2026-01-01T08:00:00.123Z");
export const CHECK_TIME = new Date("2026-01-01T08:01:00.123Z");
const stamp = { createdAt: QUOTE_TIME, updatedAt: QUOTE_TIME };

export const checkoutFixture = (mode: "FINITE" | "FOREVER" = "FOREVER", count = 6) => {
  const id = (index: number) => {
    const result = checkoutIds[index];
    if (!result) throw new Error("Fixture index");
    return result;
  };
  const business = new BusinessModel({
    _id: id(0),
    ownerUserId: id(1),
    status: "APPROVED",
    name: "Synthetic Salon",
    timezone: "Asia/Dhaka",
    visitType: "AT_BUSINESS_LOCATION",
    address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
    category: "Wellness & Beauty",
    categoryKey: "BEAUTY_WELLNESS",
    ...stamp,
  });
  const providers = [0, 1].map(
    (index) =>
      new StaffMembershipModel({
        _id: id(5 + index),
        businessId: business._id,
        userId: id(7 + index),
        createdByUserId: id(1),
        employmentActive: true,
        role: index ? "SUPERVISOR" : "STAFF",
        ...stamp,
      }),
  );
  const services = [0, 1, 2].map(
    (index) =>
      new ServiceModel({
        _id: id(10 + index),
        businessId: business._id,
        name: ["Hair", "Facial", "Massage"][index],
        status: "ACTIVE",
        isPackageDeal: false,
        pricingMode: "FIXED",
        fixedPricing: {
          priceCents: 999999,
          durationMin: 60,
          processingTimeMin: 15,
          bufferAfterMin: 10,
        },
        assignedStaffMembershipIds: providers.map((provider) => provider._id),
        servedCities: ["Larnaca", "Nicosia"],
        scheduleMode: "AUTO",
        ...stamp,
      }),
  );
  const definition = new PackageModel({
    _id: id(2),
    businessId: business._id,
    name: "Hair3 Facial2 Massage1",
    revision: 4,
    status: "ACTIVE",
    isFeatured: false,
    bundlePriceCents: 20000,
    contractTerms: {
      version: 2,
      validity: mode === "FINITE" ? { mode, months: 6 } : { mode },
      penaltyPolicyVersion: 1,
    },
    items: services.map((service, index) => ({
      itemId: id(15 + index),
      serviceId: service._id,
      includedSessions: [3, 2, 1][index],
      referenceUnitPriceCents: 10000,
      penaltyBasisCents: [5000, 3000, 0][index],
    })),
    ...stamp,
  });
  const customer = id(3);
  const client = new BusinessClientModel({
    _id: id(4),
    businessId: business._id,
    linkedUserId: customer,
    ...stamp,
  });
  const configuredPolicy = new BusinessCancellationPolicyModel({
    _id: id(9),
    businessId: business._id,
    tiers: cancellationTiers.map((tier, index) =>
      index === 0
        ? { tier, mode: "FREE" }
        : { tier, mode: "PERCENTAGE", percentage: 20 + index * 20 },
    ),
    noShowPercentage: 100,
    ...stamp,
  });
  const membership = [0, 0, 0, 1, 1, 2];
  const intent: PackageCheckoutIntent = {
    packageId: definition._id,
    expectedRevision: 4,
    selections: membership.slice(0, count).map((itemIndex, index) => ({
      selectionId: id(40 + index),
      definitionItemId: id(15 + itemIndex),
      serviceId: id(10 + itemIndex),
      staffMembershipId: id(5 + (index % 2)),
      startAt: new Date(
        Date.UTC(
          2026,
          0,
          10 + itemIndex,
          9 + (itemIndex === 0 ? index : itemIndex === 1 ? index - 3 : 0) * 2,
        ),
      ),
      addonIds: index === 0 ? [id(30)] : [],
    })),
  };
  const seed: PackageCheckoutSeed = {
    version: 1,
    quoteId: id(20),
    batchId: id(21),
    packageProgressId: id(22),
    idempotencyKey: "synthetic-checkout-key",
    issuedAt: QUOTE_TIME,
    expiresAt: new Date("2026-01-01T08:10:00.123Z"),
    businessId: business._id,
    customerUserId: customer,
    actorUserId: customer,
    actorRole: "CUSTOMER",
    temporalProofRef: id(23),
    items: definition.items.map((item, index) => ({
      definitionItemId: item.itemId,
      packageItemId: id(25 + index),
    })),
    appointments: intent.selections.map((row, index) => ({
      selectionId: row.selectionId,
      bookingId: id(50 + index),
    })),
  };
  let clock = CHECK_TIME;
  const dependencies: PackageCheckoutReadDependencies = {
    businesses: { findById: vi.fn(async () => business) },
    packages: { findById: vi.fn(async () => definition) },
    services: { findManyByIdsForBusiness: vi.fn(async () => services) },
    staff: { listActiveByBusinessId: vi.fn(async () => providers) },
    clients: { findByBusinessIdAndLinkedUserId: vi.fn(async () => client) },
    relationships: {
      peekClassification: vi.fn(FinancialRelationshipService.prototype.peekClassification),
    },
    policies: { findByBusinessId: vi.fn(async () => configuredPolicy) },
    cards: { getSavedCardStatus: vi.fn(async () => ({ hasSavedCard: true })) },
    readNoShowWindows: vi.fn(async () => []),
    travel: { findByBusinessId: vi.fn(async () => null) },
    booking: {
      validateResponsibleStaff: vi.fn(
        async (_business: unknown, serviceId: string, providerId: string) => {
          const service = services.find((service) => String(service._id) === serviceId);
          const provider = providers.find((provider) => String(provider._id) === providerId);
          if (!service || !provider) throw new Error("Synthetic unavailable staff");
          return { service, staffMembership: provider };
        },
      ),
      resolveAddonSnapshots: vi.fn(
        async (_business: unknown, _service: string, addonIds: string[]) =>
          addonIds.map((id) => ({
            addonId: new Types.ObjectId(id),
            name: "Synthetic add-on",
            priceCents: 500,
          })),
      ),
      validateFulfilmentSnapshot: vi.fn(),
    },
    availability: {
      requireServedCity: vi.fn(async () => undefined),
      getAvailability: vi.fn(
        async (
          input: Parameters<PackageCheckoutReadDependencies["availability"]["getAvailability"]>[0],
        ) => ({
          businessId: String(business._id),
          serviceId: input.serviceId,
          timezone: business.timezone,
          capacityMax: 1,
          days: [
            {
              date: input.fromDate,
              isOpen: true,
              slots: intent.selections
                .filter(
                  (row) =>
                    String(row.serviceId) === input.serviceId &&
                    String(row.staffMembershipId) === input.staffMembershipId,
                )
                .map((row) => ({
                  startAt: row.startAt.toISOString(),
                  endAt: new Date(row.startAt.getTime() + 85 * 60000).toISOString(),
                  eligibleStaffMembershipIds: [String(row.staffMembershipId)],
                  source: "AUTO" as const,
                })),
            },
          ],
        }),
      ),
    },
  };
  const preparer = new PackageCheckoutQuotePreparer(dependencies, () => clock);
  const context = {
    businessId: business._id,
    customerUserId: customer,
    actorUserId: customer,
    role: "CUSTOMER" as const,
  };
  return {
    business,
    providers,
    services,
    definition,
    client,
    configuredPolicy,
    intent,
    seed,
    dependencies,
    context,
    preparer,
    setTime: (value: Date) => {
      clock = value;
    },
    prepare: () => preparer.prepare(context, intent, seed),
    id,
  };
};

export const checkoutEvidence = (
  quote: Awaited<ReturnType<ReturnType<typeof checkoutFixture>["prepare"]>>,
) => ({
  version: 1,
  contractVersion: 1,
  acceptanceId: checkoutIds[70],
  acceptedTermsPayloadId: checkoutIds[71],
  acceptedTermsHash: quote.termsHash,
  templateId: checkoutIds[72],
  templateVersion: 1,
  actorUserId: quote.payload.customerUserId,
  customerUserId: quote.payload.customerUserId,
  actorRole: "CUSTOMER",
  acceptedAt: CHECK_TIME,
  businessId: quote.payload.businessId,
  packageId: quote.payload.packageId,
  packageRevision: quote.payload.definitionRevision,
  packageProgressId: quote.payload.packageProgressId,
  batchId: quote.payload.batchId,
  quoteId: quote.payload.quoteId,
  provenance: "CUSTOMER_ACCEPTANCE_RECORD",
  scope: "PURCHASE",
  items: quote.payload.items.map(({ packageItemId, definitionItemId, serviceId }) => ({
    packageItemId,
    definitionItemId,
    serviceId,
  })),
});
