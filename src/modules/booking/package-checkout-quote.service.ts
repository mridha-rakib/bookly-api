import type { Types } from "mongoose";
import { utcToBusinessLocalDate } from "../../common/time/business-clock.js";
import type {
  AvailabilityResult,
  AvailabilityService,
} from "../availability/availability.service.js";
import type { BusinessRepository } from "../business/business.repository.js";
import { normalizeBusinessVisitType } from "../business/business.types.js";
import type { BusinessCancellationPolicyRepository } from "../business-cancellation-policy/business-cancellation-policy.repository.js";
import type { BusinessTravelSettingsRepository } from "../business-travel-settings/business-travel-settings.repository.js";
import type { ClientRepository } from "../client/client.repository.js";
import type { FinancialRelationshipService } from "../client/financial-relationship.service.js";
import type { PackageRepository } from "../packages/package.repository.js";
import { calculatePackagePricing } from "../packages/package-pricing.js";
import {
  calculatePackageLifetimeCaptureCap,
  copyPackageDefinitionContractTerms,
  PACKAGE_SESSION_PENALTY_POLICY,
} from "../packages/package-session-penalty-policy.js";
import type { PaymentService } from "../payment/payment.service.js";
import { resolveBusinessCategoryKey } from "../platform-settings/business-category.js";
import {
  defaultNoShowWindowFor,
  type NoShowCategoryWindow,
} from "../platform-settings/platform-settings.constants.js";
import { PlatformSettingsModel } from "../platform-settings/platform-settings.model.js";
import type { ServiceRepository } from "../services/service.repository.js";
import type { StaffRepository } from "../staff/staff.repository.js";
import type { BookingService } from "./booking.service.js";
import { NO_SHOW_RESOLUTION_WINDOW_MINUTES } from "./booking.types.js";
import { bindPackageCheckoutQuote } from "./package-checkout-binding.js";
import {
  comparePackageCheckoutIds,
  type PackageCheckoutAppointment,
  packageCheckoutIntentSchema,
  packageCheckoutLocationSchema,
  packageCheckoutPolicySchema,
  packageCheckoutSeedSchema,
  quotePackageCheckoutMoney,
  selectPackageFinancialOrigin,
} from "./package-checkout-contract.js";
import { prepareFinitePackageValidityV1 } from "./package-checkout-validity.js";

/** Unlike PlatformSettingsService.resolveNoShowWindow, this read cannot lazily upsert. */
export const readPackageCheckoutNoShowWindows = async (): Promise<NoShowCategoryWindow[]> =>
  (await PlatformSettingsModel.findOne({ key: "SINGLETON" }).lean())?.noShowCategoryWindows ?? [];

export type PackageCheckoutReadDependencies = {
  businesses: Pick<BusinessRepository, "findById">;
  packages: Pick<PackageRepository, "findById">;
  services: Pick<ServiceRepository, "findManyByIdsForBusiness">;
  staff: Pick<StaffRepository, "listActiveByBusinessId">;
  clients: Pick<ClientRepository, "findByBusinessIdAndLinkedUserId">;
  relationships: Pick<FinancialRelationshipService, "peekClassification">;
  booking: Pick<
    BookingService,
    "validateResponsibleStaff" | "resolveAddonSnapshots" | "validateFulfilmentSnapshot"
  >;
  availability: Pick<AvailabilityService, "getAvailability" | "requireServedCity">;
  travel: Pick<BusinessTravelSettingsRepository, "findByBusinessId">;
  policies: Pick<BusinessCancellationPolicyRepository, "findByBusinessId">;
  cards: Pick<PaymentService, "getSavedCardStatus">;
  readNoShowWindows: typeof readPackageCheckoutNoShowWindows;
};

/** INTERNAL, read-only, not registered in a route/container. Seed identities must come
 * from a future canonical retained batch/quote claim, not customer input. This returns
 * an UNRETAINED quote, not acceptance, reserved availability, provider readiness or an
 * activation command. P3-B must retain/revalidate and compose canonical payment/batch writes.
 */
export class PackageCheckoutQuotePreparer {
  public constructor(
    private readonly reads: PackageCheckoutReadDependencies,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async prepare(
    context: {
      businessId: Types.ObjectId;
      customerUserId: Types.ObjectId;
      actorUserId: Types.ObjectId;
      role: "CUSTOMER";
    },
    intentInput: unknown,
    seedInput: unknown,
  ) {
    const intent = packageCheckoutIntentSchema.parse(intentInput);
    const seed = packageCheckoutSeedSchema.parse(seedInput);
    if (
      context.role !== "CUSTOMER" ||
      !context.actorUserId.equals(context.customerUserId) ||
      !seed.actorUserId.equals(context.actorUserId) ||
      !seed.customerUserId.equals(context.customerUserId) ||
      !seed.businessId.equals(context.businessId)
    )
      throw new Error("Authenticated checkout scope mismatch");
    const now = new Date(this.clock().getTime());
    if (!Number.isFinite(now.getTime()) || now < seed.issuedAt || now >= seed.expiresAt)
      throw new Error("Quote seed expired");
    const business = await this.reads.businesses.findById(context.businessId);
    if (
      !business?._id.equals(context.businessId) ||
      !["APPROVED", "WARNING"].includes(business.status)
    )
      throw new Error("Business unavailable");
    const definition = await this.reads.packages.findById(
      business._id,
      intent.packageId.toHexString(),
    );
    if (
      !definition?.businessId.equals(business._id) ||
      !definition._id.equals(intent.packageId) ||
      definition.status !== "ACTIVE" ||
      definition.revision !== intent.expectedRevision ||
      !definition.contractTerms ||
      definition.bundlePriceCents === undefined
    )
      throw new Error("Package offer unavailable or stale");
    calculatePackagePricing(definition.items, definition.bundlePriceCents);
    if (
      seed.items.length !== definition.items.length ||
      seed.appointments.length !== intent.selections.length
    )
      throw new Error("Batch identity membership mismatch");
    const [services, providers, client, configuredPolicy, windows, card] = await Promise.all([
      this.reads.services.findManyByIdsForBusiness(
        business._id,
        definition.items.map((item) => item.serviceId),
      ),
      this.reads.staff.listActiveByBusinessId(business._id),
      this.reads.clients.findByBusinessIdAndLinkedUserId(business._id, context.customerUserId),
      this.reads.policies.findByBusinessId(business._id),
      this.reads.readNoShowWindows(),
      this.reads.cards.getSavedCardStatus(context.customerUserId),
    ]);
    if (
      client &&
      (!client.businessId.equals(business._id) ||
        !client.linkedUserId?.equals(context.customerUserId))
    )
      throw new Error("Customer relationship scope mismatch");
    if (configuredPolicy && !configuredPolicy.businessId.equals(business._id))
      throw new Error("Foreign policy");
    const classification = this.reads.relationships.peekClassification(client);
    const terms = copyPackageDefinitionContractTerms(definition.contractTerms);
    const selectedValidity =
      terms.version === 1
        ? { mode: "FINITE" as const, months: terms.validityMonths }
        : terms.validity;
    if (selectedValidity.mode === "FINITE" && !seed.temporalProofRef)
      throw new Error("Finite guarantee retention reference required");
    const validity =
      selectedValidity.mode === "FOREVER"
        ? { mode: "FOREVER" as const }
        : prepareFinitePackageValidityV1({
            months: selectedValidity.months,
            timezone: business.timezone,
            activationNotBefore: seed.issuedAt,
            activationNotAfterExclusive: seed.expiresAt,
            guaranteeProofRef: seed.temporalProofRef as Types.ObjectId,
          });
    const items = definition.items
      .map((row) => {
        const service = services.find(
          (service) => service._id.equals(row.serviceId) && service.businessId.equals(business._id),
        );
        const planned = seed.items.find((item) => item.definitionItemId.equals(row.itemId));
        const eligible = providers.filter(
          (provider) =>
            provider.businessId.equals(business._id) &&
            !provider.removedAt &&
            provider.employmentActive &&
            ["STAFF", "SUPERVISOR"].includes(provider.role) &&
            service?.assignedStaffMembershipIds.some((id) => id.equals(provider._id)),
        );
        if (
          !service ||
          !planned ||
          service.status !== "ACTIVE" ||
          service.isPackageDeal ||
          service.pricingMode !== "FIXED" ||
          !service.fixedPricing ||
          !eligible.length ||
          row.referenceUnitPriceCents === undefined ||
          row.penaltyBasisCents === undefined
        )
          throw new Error("Package item is not new-contract eligible");
        return {
          version: 1 as const,
          packageId: definition._id,
          packageRevision: definition.revision,
          packageItemId: planned.packageItemId,
          definitionItemId: row.itemId,
          serviceId: row.serviceId,
          totalSessions: row.includedSessions,
          penaltyBasisCents: row.penaltyBasisCents,
          provenance: "ACCEPTED_DEFINITION_ITEM" as const,
          serviceName: service.name,
          baseDurationMin: service.fixedPricing.durationMin,
          referenceUnitPriceCents: row.referenceUnitPriceCents,
          serviceUpdatedAt: service.updatedAt,
          eligibleProviderIds: eligible
            .map((provider) => provider._id)
            .sort(comparePackageCheckoutIds),
        };
      })
      .sort((left, right) => comparePackageCheckoutIds(left.packageItemId, right.packageItemId));
    const category = business.categoryKey ?? resolveBusinessCategoryKey(business.category);
    const policy = packageCheckoutPolicySchema.parse({
      cancellation: configuredPolicy
        ? {
            tiers: configuredPolicy.tiers.map((tier) => ({
              tier: tier.tier,
              mode: tier.mode,
              ...(tier.percentage !== undefined ? { percentage: tier.percentage } : {}),
            })),
            noShowPercentage: configuredPolicy.noShowPercentage,
          }
        : null,
      noShowWindow: category
        ? {
            ...(windows.find((row) => row.categoryKey === category) ??
              defaultNoShowWindowFor(category)),
          }
        : null,
      noShowResolutionMinutes: NO_SHOW_RESOLUTION_WINDOW_MINUTES,
    });
    const mode = normalizeBusinessVisitType(business.visitType);
    const travelSettings =
      mode === "TRAVEL_TO_CUSTOMER" ? await this.reads.travel.findByBusinessId(business._id) : null;
    if (mode === "TRAVEL_TO_CUSTOMER" && !travelSettings?.businessId.equals(business._id))
      throw new Error("Travel settings unavailable or foreign");
    const staffCache = new Map<
      string,
      Awaited<ReturnType<BookingService["validateResponsibleStaff"]>>
    >();
    const addonCache = new Map<
      string,
      Awaited<ReturnType<BookingService["resolveAddonSnapshots"]>>
    >();
    const availabilityCache = new Map<string, AvailabilityResult>();
    const servedCache = new Set<string>();
    const appointments: PackageCheckoutAppointment[] = [];
    for (const selection of intent.selections) {
      const item = items.find(
        (item) =>
          item.definitionItemId.equals(selection.definitionItemId) &&
          item.serviceId.equals(selection.serviceId),
      );
      const planned = seed.appointments.find((row) =>
        row.selectionId.equals(selection.selectionId),
      );
      if (
        !item ||
        !planned ||
        !item.eligibleProviderIds.some((id) => id.equals(selection.staffMembershipId)) ||
        selection.startAt <= now
      )
        throw new Error("Selected item/provider/start unavailable");
      if (new Set(selection.addonIds.map(String)).size !== selection.addonIds.length)
        throw new Error("Duplicate selected add-on");
      const staffKey = `${item.serviceId}:${selection.staffMembershipId}`;
      let resolved = staffCache.get(staffKey);
      if (!resolved) {
        resolved = await this.reads.booking.validateResponsibleStaff(
          business,
          String(item.serviceId),
          String(selection.staffMembershipId),
        );
        staffCache.set(staffKey, resolved);
      }
      const { service, staffMembership } = resolved;
      if (
        !service._id.equals(item.serviceId) ||
        !service.businessId.equals(business._id) ||
        !staffMembership._id.equals(selection.staffMembershipId) ||
        !staffMembership.businessId.equals(business._id) ||
        !service.fixedPricing
      )
        throw new Error("Resolved staff/service mismatch");
      const addonKey = `${item.serviceId}:${selection.addonIds.map(String).sort().join(",")}`;
      let addons = addonCache.get(addonKey);
      if (!addons) {
        addons = await this.reads.booking.resolveAddonSnapshots(
          business,
          String(item.serviceId),
          selection.addonIds.map(String),
        );
        addonCache.set(addonKey, addons);
      }
      if (
        addons.length !== selection.addonIds.length ||
        addons.some((addon) => !selection.addonIds.some((id) => id.equals(addon.addonId)))
      )
        throw new Error("Resolved add-on membership mismatch");
      const timing = {
        version: 1 as const,
        baseDurationMin: item.baseDurationMin,
        processingTimeMin: service.fixedPricing.processingTimeMin ?? 0,
        bufferAfterMin: service.fixedPricing.bufferAfterMin ?? 0,
        occupiedDurationMin:
          item.baseDurationMin +
          (service.fixedPricing.processingTimeMin ?? 0) +
          (service.fixedPricing.bufferAfterMin ?? 0),
      };
      const endAt = new Date(selection.startAt.getTime() + timing.occupiedDurationMin * 60000);
      const coordinate =
        business.location &&
        Number.isFinite(business.location.lat) &&
        Number.isFinite(business.location.lng) &&
        Math.abs(business.location.lat) <= 90 &&
        Math.abs(business.location.lng) <= 180
          ? { lat: business.location.lat, lng: business.location.lng }
          : undefined;
      const location = packageCheckoutLocationSchema.parse(
        mode === "AT_BUSINESS_LOCATION"
          ? {
              mode,
              businessLocation: {
                city: business.address.city,
                area: business.address.area,
                streetName: business.address.streetName,
                streetNumber: business.address.streetNumber,
                floorUnit: business.address.floorUnit,
                aptRoom: business.address.aptRoom,
                ...(coordinate ? { location: coordinate } : {}),
              },
            }
          : { mode, travelAddress: selection.travelAddress },
      );
      if (
        (mode === "AT_BUSINESS_LOCATION" && selection.travelAddress) ||
        (mode === "TRAVEL_TO_CUSTOMER" && !selection.travelAddress)
      )
        throw new Error("Location mode mismatch");
      this.reads.booking.validateFulfilmentSnapshot(business, location);
      const city = selection.travelAddress?.city;
      const travelCity = travelSettings?.cities.find((row) => row.city === city && row.active);
      if (mode === "TRAVEL_TO_CUSTOMER" && !travelCity)
        throw new Error("Travel city quote changed");
      const cityKey = `${item.serviceId}:${city}`;
      if (mode === "TRAVEL_TO_CUSTOMER" && !servedCache.has(cityKey)) {
        await this.reads.availability.requireServedCity(business, service, city);
        servedCache.add(cityKey);
      }
      const date = utcToBusinessLocalDate(business.timezone, selection.startAt).dateStr;
      const key = `${staffKey}:${date}:${city}`;
      let available = availabilityCache.get(key);
      if (!available) {
        available = await this.reads.availability.getAvailability({
          businessId: String(business._id),
          serviceId: String(item.serviceId),
          staffMembershipId: String(selection.staffMembershipId),
          fromDate: date,
          toDate: date,
          partySize: 1,
          ...(city ? { customerCity: city } : {}),
          ...(mode === "TRAVEL_TO_CUSTOMER" ? { skipTravelEligibility: true } : {}),
        });
        availabilityCache.set(key, available);
      }
      if (
        available.businessId !== String(business._id) ||
        available.serviceId !== String(item.serviceId) ||
        available.timezone !== business.timezone ||
        available.capacityMax !== 1
      )
        throw new Error("Availability context mismatch");
      const slot = available.days
        .flatMap((day) => day.slots)
        .find(
          (slot) =>
            new Date(slot.startAt).getTime() === selection.startAt.getTime() &&
            new Date(slot.endAt).getTime() === endAt.getTime() &&
            slot.eligibleStaffMembershipIds.includes(String(selection.staffMembershipId)),
        );
      if (!slot) throw new Error("Selected slot no longer available");
      appointments.push({
        selectionId: selection.selectionId,
        bookingId: planned.bookingId,
        packageItemId: item.packageItemId,
        definitionItemId: item.definitionItemId,
        serviceId: item.serviceId,
        staffMembershipId: selection.staffMembershipId,
        startAt: selection.startAt,
        endAt,
        timing,
        location: location as PackageCheckoutAppointment["location"],
        addons: [...addons].sort((left, right) =>
          comparePackageCheckoutIds(left.addonId, right.addonId),
        ),
        travelFeeCents: mode === "TRAVEL_TO_CUSTOMER" ? (travelCity?.feeCents ?? 0) : 0,
        schedulingSource: slot.source,
        availabilityCheckedAt: now,
        staffUpdatedAt: staffMembership.updatedAt,
      });
    }
    appointments.sort((left, right) =>
      comparePackageCheckoutIds(left.selectionId, right.selectionId),
    );
    const originBookingId = selectPackageFinancialOrigin(appointments);
    const finish = this.clock();
    if (
      !Number.isFinite(finish.getTime()) ||
      finish >= seed.expiresAt ||
      appointments.some((row) => row.startAt <= finish)
    )
      throw new Error("Quote expired during preparation");
    return bindPackageCheckoutQuote({
      version: 1,
      quoteId: seed.quoteId,
      batchId: seed.batchId,
      packageProgressId: seed.packageProgressId,
      idempotencyKey: seed.idempotencyKey,
      businessId: business._id,
      customerUserId: context.customerUserId,
      actorUserId: context.actorUserId,
      actorRole: "CUSTOMER",
      packageId: definition._id,
      packageName: definition.name,
      definitionRevision: definition.revision,
      definitionTerms: terms,
      issuedAt: seed.issuedAt,
      expiresAt: seed.expiresAt,
      businessTimezone: business.timezone,
      source: "BOOKLY_MANAGED",
      state: "INTERNAL_UNRETAINED_NOT_ACCEPTED",
      items,
      appointments,
      originBookingId,
      validity,
      financials: quotePackageCheckoutMoney(
        definition.bundlePriceCents,
        classification,
        originBookingId,
        appointments,
      ),
      penalty: {
        policyVersion: PACKAGE_SESSION_PENALTY_POLICY.version,
        currency: "EUR",
        soldBundlePriceCents: definition.bundlePriceCents,
        appointmentCapCents: PACKAGE_SESSION_PENALTY_POLICY.appointmentCaptureCapCents,
        lifetimeCapCents: calculatePackageLifetimeCaptureCap(definition.bundlePriceCents),
        noPurchaseDepositOffset: true,
        scope: "INCLUDED_SESSION_ONLY",
        provenance: "ACCEPTED_SOLD_BUNDLE_PRICE",
        captureBudgetSemantics: {
          succeeded: "PERMANENT_SPEND",
          pendingOrUnknown: "RESERVE",
          definitiveNonCollection: "RELEASE",
          refundsAndDisputes: "NO_CAPACITY_RESTORE",
          fixedAssessment: "NO_AUTOMATIC_TOP_UP",
        },
      },
      policy,
      disclosure: {
        version: 1,
        unusedCreditsExpireOnlyWhenFinite: true,
        scheduledAttemptsSurviveExpiry: true,
        expiryNeverChargesMoney: true,
        qualifyingEventMayForfeitCreditAndChargeSeparately: true,
        savedCardUseRequiresExplicitAcceptance: true,
        purchaseDepositOffsetsPenalty: false,
        normalDuesAreManual: true,
        monetaryTermsProspectiveOnly: true,
      },
      savedCardStatus: card.hasSavedCard ? "LOCAL_REFERENCE_PRESENT" : "MISSING",
      providerState: "NOT_DISPATCHED",
    });
  }
}
