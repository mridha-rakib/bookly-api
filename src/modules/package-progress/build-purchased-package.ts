import { Types } from "mongoose";
import type { BusinessDocument } from "../business/business.model.js";
import { normalizeBusinessVisitType } from "../business/business.types.js";
import type { BusinessTravelSettingsDocument } from "../business-travel-settings/business-travel-settings.model.js";
import type { PackageDocument } from "../packages/package.model.js";
import { calculatePackagePricing } from "../packages/package-pricing.js";
import { resolvePackageServiceEntitlement } from "../packages/package-service-entitlement.js";
import type { ServiceDocument } from "../services/service.model.js";
import { packageProgressV2InputSchema } from "./package-progress-v2.rules.js";
import type { CreatePackageProgressV2Input } from "./package-progress-v2.types.js";

/** Server-only construction contract. Resolves definition items to actual Services, allocates
 * distinct purchased identities, and includes the mandatory first scheduled attempt. It does
 * not persist, reserve a slot, settle money or authorize a Customer request. */
export const buildPurchasedPackage = (input: {
  definition: PackageDocument;
  business: BusinessDocument;
  services: ServiceDocument[];
  travelSettings?: Pick<BusinessTravelSettingsDocument, "cities">;
  customerUserId: Types.ObjectId;
  businessClientId: Types.ObjectId;
  originBookingId: Types.ObjectId;
  firstItemId: Types.ObjectId;
  packageProgressId?: Types.ObjectId;
}): CreatePackageProgressV2Input => {
  const { definition, business } = input;
  if (
    !definition.businessId.equals(business._id) ||
    definition.status !== "ACTIVE" ||
    definition.bundlePriceCents === undefined
  )
    throw new Error("Package is not sellable");
  const mode = normalizeBusinessVisitType(business.visitType);
  const items = definition.items.map((row) => {
    const service = input.services.find(
      (service) => service._id.equals(row.serviceId) && service.businessId.equals(business._id),
    );
    const entitlement = service && resolvePackageServiceEntitlement(service);
    if (
      service?.status !== "ACTIVE" ||
      service.isPackageDeal ||
      !entitlement ||
      row.referenceUnitPriceCents === undefined
    )
      throw new Error("Invalid Package Service");
    return {
      packageItemId: new Types.ObjectId(),
      definitionItemId: row.itemId,
      serviceId: row.serviceId,
      serviceSnapshot: {
        name: service.name,
        pricingMode: entitlement.pricingMode,
        durationMin: entitlement.durationMin,
        ...(entitlement.group ? { group: entitlement.group } : {}),
      },
      totalSessions: row.includedSessions,
      remainingSessions: row.includedSessions,
      completedSessions: 0,
      referenceUnitPriceCents: row.referenceUnitPriceCents,
      ...(mode === "TRAVEL_TO_CUSTOMER"
        ? {
            travelCities: (input.travelSettings?.cities ?? [])
              .filter((city) => city.active && service.servedCities.includes(city.city))
              .map((city) => ({ city: city.city, feeCents: city.feeCents })),
          }
        : {}),
    };
  });
  const first = items.find((item) => item.definitionItemId.equals(input.firstItemId));
  if (!first) throw new Error("First item does not belong to Package");
  first.remainingSessions -= 1;
  const pricing = calculatePackagePricing(definition.items, definition.bundlePriceCents);
  if (pricing.referenceTotalCents === null || pricing.discountPercent === null)
    throw new Error("Incomplete reference terms");
  return packageProgressV2InputSchema.parse({
    _id: input.packageProgressId ?? new Types.ObjectId(),
    schemaVersion: 2,
    businessId: business._id,
    customerUserId: input.customerUserId,
    businessClientId: input.businessClientId,
    packageId: definition._id,
    originBookingId: input.originBookingId,
    purchaseSnapshot: {
      name: definition.name,
      packageRevision: definition.revision,
      bundlePriceCents: definition.bundlePriceCents,
      referenceTotalCents: pricing.referenceTotalCents,
      discountPercent: pricing.discountPercent,
      currency: "EUR",
      fulfilmentMode: mode,
    },
    items,
    sessions: [
      {
        bookingId: input.originBookingId,
        packageItemId: first.packageItemId,
        serviceId: first.serviceId,
        status: "SCHEDULED",
      },
    ],
  });
};
