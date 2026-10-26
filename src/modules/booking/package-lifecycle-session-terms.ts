import { type ClientSession, Types } from "mongoose";
import { z } from "zod";
import { AddonModel } from "../addons/addon.model.js";
import { AddonServiceAssignmentModel } from "../addons/addon-service-assignment.model.js";
import { BusinessModel } from "../business/business.model.js";
import { BusinessTravelSettingsModel } from "../business-travel-settings/business-travel-settings.model.js";
import { computePackageBalanceSettlement } from "../package-progress/package-progress.rules.js";
import { PackageProgressV2Model } from "../package-progress/package-progress-v2.model.js";
import {
  packageGroupSeatSchema,
  resolvePackageServiceEntitlement,
} from "../packages/package-service-entitlement.js";
import { ServiceModel } from "../services/service.model.js";
import { StaffMembershipModel } from "../staff/staff.model.js";
import { BookingCreationClaimModel } from "./booking-creation-claim.model.js";
import { verifyPackageBatchActivation } from "./package-batch-authority.js";
import { verifyBatchCompletion } from "./package-batch-completion.js";
import { batchConflict } from "./package-batch-contract.js";
import { hashCanonicalPackageCheckoutContent as digest } from "./package-checkout-binding.js";
import { packageCheckoutLocationSchema } from "./package-checkout-contract.js";
import type { LifecycleIntent } from "./package-lifecycle-operation.js";

const id = z.instanceof(Types.ObjectId),
  cents = z.number().int().safe().nonnegative();
export const lifecycleSessionTermsSchema = z
  .object({
    version: z.literal(1),
    intentHash: z.string().regex(/^[a-f0-9]{64}$/),
    bookingId: id,
    serviceId: id,
    serviceName: z.string().min(1),
    serviceUpdatedAt: z.date(),
    staffMembershipId: id,
    startAt: z.date(),
    endAt: z.date(),
    timezone: z.string().min(1),
    fulfilment: packageCheckoutLocationSchema,
    group: packageGroupSeatSchema.optional(),
    baseCents: z.literal(0),
    addons: z
      .array(
        z
          .object({ addonId: id, name: z.string().min(1), priceCents: cents, updatedAt: z.date() })
          .strict(),
      )
      .max(50),
    travelRightsHash: z.string().regex(/^[a-f0-9]{64}$/),
    travelCents: cents,
    addonsCents: cents,
    totalCents: cents,
    currency: z.literal("EUR"),
    paymentMethod: z.enum(["VENUE", "ONLINE"]),
  })
  .strict();
export const lifecycleSessionQuoteSchema = z
  .object({
    version: z.literal(1),
    quoteId: id,
    sessionFamilyId: z.string().min(1),
    issuedAt: z.date(),
    challenge: z.string().min(32),
    terms: lifecycleSessionTermsSchema,
    termsHash: z.string().regex(/^[a-f0-9]{64}$/),
    disclosure: z.string().min(1),
    disclosureHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const lifecycleSessionAcceptanceSchema = z
  .object({
    version: z.literal(1),
    acceptanceId: id,
    quoteId: id,
    termsHash: z.string().regex(/^[a-f0-9]{64}$/),
    disclosureHash: z.string().regex(/^[a-f0-9]{64}$/),
    customerUserId: id,
    sessionFamilyId: z.string().min(1),
    acceptedAt: z.date(),
    action: z.literal("ACCEPT_SESSION_DUES"),
  })
  .strict();
export type LifecycleSessionTerms = z.infer<typeof lifecycleSessionTermsSchema>;
/** Exact source-derived terms. Called only under the shared Business write. Selected Add-on
 * and assignment writes order their existing independent writers before authoritative reads. */
export async function deriveLifecycleSessionTerms(
  intent: LifecycleIntent,
  bookingId: Types.ObjectId,
  session: ClientSession,
  now: Date,
): Promise<LifecycleSessionTerms> {
  await verifyPackageBatchActivation();
  if (
    !session.inTransaction() ||
    intent.action !== "REDEEM" ||
    !intent.dues ||
    !intent.packageItemId ||
    !intent.staffMembershipId ||
    !intent.startAt ||
    intent.startAt <= now ||
    new Set(intent.dues.addonIds.map(String)).size !== intent.dues.addonIds.length
  )
    throw batchConflict();
  const loadedProgress = await PackageProgressV2Model.findOne({
    _id: intent.packageProgressId,
    businessId: intent.businessId,
    customerUserId: intent.customerUserId,
    businessClientId: intent.businessClientId,
  })
    .session(session)
    .orFail();
  const progress = loadedProgress.toObject();
  if (
    progress.creditAccountingVersion !== 2 ||
    progress.voidedAt ||
    (progress.purchasedContract.validity.mode === "FINITE" &&
      (now >= progress.purchasedContract.validity.expiresAt ||
        intent.startAt >= progress.purchasedContract.validity.expiresAt))
  )
    throw batchConflict();
  const item = progress.items.find((i) =>
    i.packageItemId.equals(intent.packageItemId ?? new Types.ObjectId()),
  );
  if (!item || item.remainingSessions < 1) throw batchConflict();
  const claim = await BookingCreationClaimModel.findOne({
    businessId: intent.businessId,
    actorUserId: intent.customerUserId,
    "packageBatchPreparation.packageProgressId": progress._id,
  })
    .session(session)
    .orFail();
  const purchase = await verifyBatchCompletion(claim, session);
  const original = purchase.bookings.find((b) => b._id.equals(progress.originBookingId));
  const business = await BusinessModel.findById(intent.businessId).session(session).orFail();
  const service = await ServiceModel.findOne({
    _id: item.serviceId,
    businessId: intent.businessId,
    status: { $in: ["ACTIVE", "INACTIVE"] },
    archivedAt: { $exists: false },
  })
    .session(session)
    .orFail();
  const entitlement = resolvePackageServiceEntitlement(service);
  const staff = await StaffMembershipModel.findOne({
    _id: intent.staffMembershipId,
    businessId: intent.businessId,
    employmentActive: true,
    role: { $in: ["STAFF", "SUPERVISOR"] },
    removedAt: { $exists: false },
  }).session(session);
  if (!staff || !service.assignedStaffMembershipIds.some((id) => id.equals(staff._id)))
    throw batchConflict();

  if (
    !original ||
    !computePackageBalanceSettlement(original).balanceSettled ||
    !entitlement ||
    entitlement.pricingMode !== item.serviceSnapshot.pricingMode ||
    digest(entitlement.group ?? null) !== digest(item.serviceSnapshot.group ?? null) ||
    original.schedule.timezone !== business.timezone
  )
    throw batchConflict();
  let fulfilment = packageCheckoutLocationSchema.parse(original.fulfilment),
    travelCents = 0;
  if (progress.purchaseSnapshot.fulfilmentMode === "TRAVEL_TO_CUSTOMER") {
    if (!intent.dues.travelAddress || business.visitType !== "TRAVEL_TO_CUSTOMER")
      throw batchConflict();
    const address = intent.dues.travelAddress;
    const rights = item.travelCities?.find((c) => c.city === address.city);
    const settings = await BusinessTravelSettingsModel.findOne({
      businessId: business._id,
    }).session(session);
    if (
      !rights ||
      !service.servedCities.includes(address.city) ||
      !settings?.cities.some((c) => c.active && c.city === address.city)
    )
      throw batchConflict();
    fulfilment = packageCheckoutLocationSchema.parse({
      mode: "TRAVEL_TO_CUSTOMER",
      travelAddress: address,
    });
    travelCents = rights.feeCents;
  } else {
    if (intent.dues.travelAddress || business.visitType !== "AT_BUSINESS_LOCATION")
      throw batchConflict();
    const businessLocation = {
      ...business.toObject().address,
      ...(business.location &&
      Number.isFinite(business.location.lat) &&
      Number.isFinite(business.location.lng) &&
      Math.abs(business.location.lat) <= 90 &&
      Math.abs(business.location.lng) <= 180
        ? { location: { lat: business.location.lat, lng: business.location.lng } }
        : {}),
    };
    fulfilment = packageCheckoutLocationSchema.parse({
      mode: "AT_BUSINESS_LOCATION",
      businessLocation,
    });
  }
  const addons: LifecycleSessionTerms["addons"] = [];
  for (const addonId of [...intent.dues.addonIds].sort((a, b) =>
    String(a).localeCompare(String(b)),
  )) {
    const addon = await AddonModel.findOneAndUpdate(
      {
        _id: addonId,
        businessId: intent.businessId,
        status: "ACTIVE",
        archivedAt: { $exists: false },
      },
      { $inc: { __v: 1 } },
      { session, returnDocument: "after", timestamps: false },
    );
    const assignment = await AddonServiceAssignmentModel.findOneAndUpdate(
      { businessId: intent.businessId, addonId, serviceId: item.serviceId },
      { $inc: { __v: 1 } },
      { session, returnDocument: "after", timestamps: false },
    );
    if (!addon || !assignment || addon.priceCents === undefined) throw batchConflict();
    addons.push({
      addonId,
      name: addon.name,
      priceCents: addon.priceCents,
      updatedAt: addon.updatedAt,
    });
  }
  const addonTotal = addons.reduce((sum, a) => sum + BigInt(a.priceCents), 0n),
    total = addonTotal + BigInt(travelCents);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw batchConflict();
  const endAt = new Date(
    intent.startAt.getTime() +
      (item.serviceSnapshot.durationMin +
        (entitlement.bufferAfterMin ?? 0) +
        (entitlement.processingTimeMin ?? 0)) *
        60000,
  );
  return lifecycleSessionTermsSchema.parse({
    version: 1,
    intentHash: digest(intent),
    bookingId,
    serviceId: service._id,
    serviceName: item.serviceSnapshot.name,
    serviceUpdatedAt: service.updatedAt,
    staffMembershipId: intent.staffMembershipId,
    startAt: intent.startAt,
    endAt,
    timezone: business.timezone,
    fulfilment,
    ...(item.serviceSnapshot.group ? { group: item.serviceSnapshot.group } : {}),
    baseCents: 0,
    addons,
    travelRightsHash: digest(item.travelCities ?? []),
    travelCents,
    addonsCents: Number(addonTotal),
    totalCents: Number(total),
    currency: "EUR",
    paymentMethod: intent.dues.paymentMethod,
  });
}
