/** biome-ignore-all lint/style/noNonNullAssertion: Fixture dimensions and successful reads are asserted by these tests; optional chaining would silently skip mutations. */
import mongoose, { type ClientSession, Types } from "mongoose";
import { BusinessModel } from "../../src/modules/business/business.model.js";
import { BusinessClientModel } from "../../src/modules/client/client.model.js";
import { buildPurchasedPackage } from "../../src/modules/package-progress/build-purchased-package.js";
import { PackageProgressV2Model } from "../../src/modules/package-progress/package-progress-v2.model.js";
import { PackageProgressV2Repository } from "../../src/modules/package-progress/package-progress-v2.repository.js";
import { packageProgressV2InputSchema } from "../../src/modules/package-progress/package-progress-v2.rules.js";
import { PackageModel } from "../../src/modules/packages/package.model.js";
import type { ServiceDocument } from "../../src/modules/services/service.model.js";
import { ServiceModel } from "../../src/modules/services/service.model.js";
import type { ReplaceServiceFields } from "../../src/modules/services/service.repository.js";
import { StaffMembershipModel } from "../../src/modules/staff/staff.model.js";

export const transaction = async <T>(work: (session: ClientSession) => Promise<T>): Promise<T> => {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => work(session));
  } finally {
    await session.endSession();
  }
};

export const serviceFields = (service: ServiceDocument): ReplaceServiceFields => ({
  name: service.name,
  description: service.description,
  category: service.category,
  subcategory: service.subcategory,
  serviceCategoryId: service.serviceCategoryId,
  status: service.status,
  isFeatured: service.isFeatured,
  isPackageDeal: service.isPackageDeal,
  pricingMode: service.pricingMode,
  fixedPricing: service.fixedPricing,
  hourlyPricing: service.hourlyPricing,
  perPersonPricing: service.perPersonPricing,
  packagePricing: service.packagePricing,
  packageServicesName: service.packageServicesName,
  sessionExpiryAlert: service.sessionExpiryAlert,
  scheduleMode: service.scheduleMode,
  manualSchedule: service.manualSchedule,
  assignedStaffMembershipIds: service.assignedStaffMembershipIds,
  servedCities: service.servedCities,
});

export const packageV2Fixture = async (quantities = [3, 2, 1], persist = true) => {
  const ownerId = new Types.ObjectId();
  const customerId = new Types.ObjectId();
  const business = await BusinessModel.create({
    ownerUserId: ownerId,
    name: "P2 Salon",
    ownerName: "Owner",
    email: "salon@example.com",
    phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
    status: "APPROVED",
    visitType: "AT_BUSINESS_LOCATION",
    address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
    briefDescription: "P2 tests",
    category: "Wellness & Beauty",
    subcategories: ["Massage"],
  });
  const provider = await StaffMembershipModel.create({
    businessId: business._id,
    userId: new Types.ObjectId(),
    role: "STAFF",
    employmentActive: true,
    createdByUserId: ownerId,
  });
  const services = await Promise.all(
    quantities.map((_, index) =>
      ServiceModel.create({
        businessId: business._id,
        name: `Treatment ${index}`,
        status: "ACTIVE",
        isPackageDeal: false,
        isFeatured: false,
        category: business.category,
        subcategory: "Massage",
        serviceCategoryId: new Types.ObjectId(),
        pricingMode: "FIXED",
        fixedPricing: { priceCents: 1000, durationMin: 60 },
        assignedStaffMembershipIds: [provider._id],
        servedCities: [],
        scheduleMode: "AUTO",
        sessionExpiryAlert: { enabled: false },
      }),
    ),
  );
  const definition = await PackageModel.create({
    businessId: business._id,
    name: "P2 bundle",
    category: business.category,
    subcategory: "Massage",
    serviceCategoryId: new Types.ObjectId(),
    status: "ACTIVE",
    isFeatured: false,
    revision: 1,
    items: services.map((service, index) => ({
      itemId: new Types.ObjectId(),
      serviceId: service._id,
      includedSessions: quantities[index]!,
      referenceUnitPriceCents: 100,
    })),
    bundlePriceCents: 100,
  });
  const client = await BusinessClientModel.create({
    businessId: business._id,
    createdByUserId: ownerId,
    firstName: "Buyer",
    normalizedEmail: "buyer@example.com",
    phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
    linkState: "LINKED",
    linkedUserId: customerId,
  });
  const input = buildPurchasedPackage({
    definition,
    business,
    services,
    customerUserId: customerId,
    businessClientId: client._id,
    originBookingId: new Types.ObjectId(),
    firstItemId: definition.items[0]!.itemId,
  });
  const repository = new PackageProgressV2Repository();
  if (persist) await transaction((session) => repository.create(input, session));
  const scope = (index = 0) => ({
    packageProgressId: input._id,
    businessId: business._id,
    customerUserId: customerId,
    packageItemId: input.items[index]!.packageItemId,
    serviceId: input.items[index]!.serviceId,
  });
  const read = async () => {
    const progress = await PackageProgressV2Model.findById(input._id).lean();
    if (!progress) throw new Error("Missing v2 progress");
    const { createdAt: _created, updatedAt: _updated, ...data } = progress;
    packageProgressV2InputSchema.parse(data);
    return progress;
  };
  return {
    business,
    ownerId,
    customerId,
    provider,
    services,
    definition,
    client,
    input,
    repository,
    scope,
    read,
  };
};
