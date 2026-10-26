import { isDeepStrictEqual } from "node:util";
import mongoose, { type ClientSession } from "mongoose";
import { utcToBusinessLocalDate } from "../../common/time/business-clock.js";
import type { AvailabilityService } from "../availability/availability.service.js";
import type { BookingSlotReservationService } from "../booking-slot-reservation/booking-slot-reservation.service.js";
import { packageInitialReservationKey } from "../booking-slot-reservation/reservation-operation.js";
import { type BusinessDocument, BusinessModel } from "../business/business.model.js";
import { BusinessCancellationPolicyModel } from "../business-cancellation-policy/business-cancellation-policy.model.js";
import { BusinessClientModel } from "../client/client.model.js";
import {
  acquirePackageEligibilityFence,
  requirePackageTransaction,
} from "../package-progress/package-eligibility.js";
import { PackageProgressV2Repository } from "../package-progress/package-progress-v2.repository.js";
import { packageProgressV2InputSchema } from "../package-progress/package-progress-v2.rules.js";
import { PackageModel } from "../packages/package.model.js";
import { calculatePackagePricing } from "../packages/package-pricing.js";
import { resolvePackageServiceEntitlement } from "../packages/package-service-entitlement.js";
import { copyPackageDefinitionContractTerms } from "../packages/package-session-penalty-policy.js";
import { resolveBusinessCategoryKey } from "../platform-settings/business-category.js";
import { type ServiceDocument, ServiceModel } from "../services/service.model.js";
import { StaffMembershipModel } from "../staff/staff.model.js";
import { UserProfileModel } from "../user/user.model.js";
import { BookingRepository } from "./booking.repository.js";
import {
  claimInternalPackageBatch,
  commitInternalPackageBatch,
  loadOwnedPackageBatch,
  type PackageBatchScope,
  prepareInternalPackageBatch,
  readOwnedPackageBatchMaterialization,
  releaseKnownAbortedPackageBatch,
} from "./booking-creation-claim.model.js";
import {
  acquireSchedulingAdmission,
  validateSchedulingLine,
} from "./booking-scheduling-admission.js";
import { validateBatchAcceptedDependencies } from "./package-batch-accepted-dependencies.js";
import { verifyPackageBatchActivation } from "./package-batch-authority.js";
import {
  assertBatchPreparation,
  batchConflict,
  canonicalPackageBatch,
  type PackageBatchPreparation,
  PackageBatchUnresolvedError,
  packageBatchOperation,
} from "./package-batch-contract.js";
import { PackageCheckoutConflictError } from "./package-checkout.errors.js";
import { hashCanonicalPackageCheckoutContent } from "./package-checkout-binding.js";
import { validatePackageActivationDeadline } from "./package-checkout-validity.js";

/** Internal F1 kernel. No route/container/worker registration. Shipped authority rejects before
 * the first DB operation. Synthetic test module mocks prove materialization, never purchase.
 * F2 must extend writeInTransaction BEFORE the parent commit, not complete a later transaction. */
export class PackageBatchPersistence {
  public constructor(
    private readonly availability: AvailabilityService,
    private readonly reservations: BookingSlotReservationService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** F2 composition seam: joins its caller's parent session, never starts/commits a child
   * transaction and returns no commercially successful result. F2 must add its money,
   * delivery and commercial proof before THAT parent commits. This remains activation-denied.
   * The caller owns the server token and definite-abort/uncertainty classification. */
  public async materializeInSession(
    scope: PackageBatchScope,
    token: string,
    session: ClientSession,
  ): Promise<void> {
    await verifyPackageBatchActivation();
    requirePackageTransaction(session);
    await acquirePackageEligibilityFence(scope.businessId, session);
    const row = await loadOwnedPackageBatch(scope, session);
    const p = assertBatchPreparation(row.toObject(), row.packageBatchPreparation);
    const { quote: q } = canonicalPackageBatch(row.toObject());
    const now = new Date(this.clock().getTime());
    if (
      row.packageBatchControl?.phase !== "PERSISTING" ||
      row.packageBatchControl.token !== token ||
      row.packageBatchMaterialization ||
      now < q.issuedAt ||
      now >= q.expiresAt ||
      !Number.isFinite(now.getTime()) ||
      (!row.packageBatchFinance &&
        (q.financials.requiredUpfrontCents !== 0 ||
          q.appointments.some(
            (m) => m.location.mode !== "AT_BUSINESS_LOCATION" || m.addons.length !== 0,
          ) ||
          q.policy.cancellation !== null ||
          q.policy.noShowWindow !== null))
    )
      throw batchConflict();
    const business = await BusinessModel.findById(scope.businessId).session(session).orFail();
    await this.#writeInTransaction(scope, p, token, business, session);
  }

  public async materialize(scope: PackageBatchScope) {
    await verifyPackageBatchActivation();
    const existing = await readOwnedPackageBatchMaterialization(scope).catch((error: unknown) => {
      if (error instanceof PackageCheckoutConflictError) throw error;
      throw new PackageBatchUnresolvedError();
    });
    if (existing) return existing;
    const canonical = await loadOwnedPackageBatch(scope);
    if (canonical.packageBatchControl?.phase === "PERSISTING") return this.resolve(scope);
    const { quote: q } = canonicalPackageBatch(canonical.toObject());
    const now = new Date(this.clock().getTime());
    if (!Number.isFinite(now.getTime()) || now < q.issuedAt || now >= q.expiresAt)
      throw batchConflict();
    // No fake paid snapshot or accepted future rights. These inputs need F2's authorities.
    if (
      q.financials.requiredUpfrontCents !== 0 ||
      q.appointments.some(
        (m) => m.location.mode !== "AT_BUSINESS_LOCATION" || m.addons.length !== 0,
      ) ||
      q.policy.cancellation !== null ||
      q.policy.noShowWindow !== null
    )
      throw batchConflict();
    const expectedBusiness = await BusinessModel.findById(scope.businessId).orFail();
    const p = await prepareInternalPackageBatch(scope, now);
    const token = await claimInternalPackageBatch(scope, p);
    if (!token) return this.resolve(scope);
    const session = await mongoose.startSession();
    let callbackReturned = false;
    try {
      await session.withTransaction(async () => {
        callbackReturned = false;
        const business = await acquireSchedulingAdmission(expectedBusiness, session);
        const row = await loadOwnedPackageBatch(scope, session);
        const current = assertBatchPreparation(row.toObject(), row.packageBatchPreparation);
        if (
          !isDeepStrictEqual(current, p) ||
          row.packageBatchControl?.phase !== "PERSISTING" ||
          row.packageBatchControl.token !== token ||
          row.packageBatchMaterialization
        )
          throw batchConflict();
        await this.#writeInTransaction(scope, p, token, business, session);
        callbackReturned = true;
      });
    } catch (error) {
      const unknown =
        callbackReturned ||
        (typeof error === "object" &&
          error !== null &&
          (("hasErrorLabel" in error &&
            typeof error.hasErrorLabel === "function" &&
            error.hasErrorLabel("UnknownTransactionCommitResult")) ||
            ("errorLabels" in error &&
              Array.isArray(error.errorLabels) &&
              error.errorLabels.includes("UnknownTransactionCommitResult"))));
      if (unknown) return this.resolve(scope);
      await releaseKnownAbortedPackageBatch(scope, token);
      throw error;
    } finally {
      // Cleanup cannot undo a committed internal result or become compensation authority.
      await session.endSession().catch(() => undefined);
    }
    return this.resolve(scope);
  }

  private async resolve(scope: PackageBatchScope) {
    // Bounded observations, outside the failed transaction; no cleanup or age-based restart.
    for (let i = 0; i < 6; i += 1) {
      try {
        const winner = await readOwnedPackageBatchMaterialization(scope);
        if (winner) return winner;
      } catch {
        /* An unavailable/incomplete winner remains unresolved. */
      }
    }
    throw new PackageBatchUnresolvedError();
  }

  async #writeInTransaction(
    scope: PackageBatchScope,
    p: PackageBatchPreparation,
    token: string,
    business: BusinessDocument,
    session: ClientSession,
  ) {
    const row = await loadOwnedPackageBatch(scope, session);
    const { quote: q, accepted } = canonicalPackageBatch(row.toObject());
    // Freshness is rechecked in each callback, not inherited from a previous aborted attempt.
    // This is a pre-admission check, never a B1c commit-time clock/deadline guarantee.
    const observedAt = new Date(this.clock().getTime());
    if (
      !Number.isFinite(observedAt.getTime()) ||
      observedAt < q.issuedAt ||
      observedAt >= q.expiresAt ||
      q.appointments.some((m) => m.startAt <= observedAt)
    )
      throw batchConflict();
    if (
      business.timezone !== q.businessTimezone ||
      business.visitType !== q.appointments[0]?.location.mode ||
      (!row.packageBatchFinance &&
        (business.categoryKey || resolveBusinessCategoryKey(business.category)))
    )
      throw batchConflict();
    // The only supported policy absence is checked under the same Business write as its
    // actual application writer. Category/global-window cases remain explicitly unsupported.
    if (row.packageBatchFinance) await validateBatchAcceptedDependencies(q, business, session);
    else if (
      await BusinessCancellationPolicyModel.exists({ businessId: p.businessId }).session(session)
    )
      throw batchConflict();
    const definition = await PackageModel.findOne({
      _id: q.packageId,
      businessId: p.businessId,
      status: "ACTIVE",
    }).session(session);
    // Identity-link writers do not use the scheduling coordinator. An actual write on the
    // existing Client row orders their changes with this ownership decision. __v is the
    // existing Mongoose version, not FIRST/lease/credit authority; it rolls back with admission.
    const client = await BusinessClientModel.findOneAndUpdate(
      {
        _id: p.businessClientId,
        businessId: p.businessId,
        linkedUserId: p.customerUserId,
      },
      { $inc: { __v: 1 } },
      { session, returnDocument: "after", timestamps: false },
    );
    if (
      !definition ||
      !client ||
      definition.revision !== q.definitionRevision ||
      definition.name !== q.packageName ||
      definition.bundlePriceCents !== q.financials.bundlePriceCents ||
      !definition.contractTerms ||
      !isDeepStrictEqual(
        copyPackageDefinitionContractTerms(definition.contractTerms),
        q.definitionTerms,
      ) ||
      definition.items.length !== q.items.length
    )
      throw batchConflict();
    const services = new Map<string, ServiceDocument>();
    for (const item of q.items) {
      const service = await ServiceModel.findOne({
        _id: item.serviceId,
        businessId: p.businessId,
      }).session(session);
      const entitlement = service && resolvePackageServiceEntitlement(service);
      const definitionItem = definition.items.find(
        (i) => i.itemId.equals(item.definitionItemId) && i.serviceId.equals(item.serviceId),
      );
      if (
        !service ||
        !entitlement ||
        !definitionItem ||
        service.updatedAt.getTime() !== item.serviceUpdatedAt.getTime() ||
        service.name !== item.serviceName ||
        entitlement.durationMin !== item.baseDurationMin ||
        !isDeepStrictEqual(entitlement.group, item.group) ||
        definitionItem.includedSessions !== item.totalSessions ||
        definitionItem.referenceUnitPriceCents !== item.referenceUnitPriceCents ||
        definitionItem.penaltyBasisCents !== item.penaltyBasisCents
      )
        throw batchConflict();
      services.set(item.serviceId.toHexString(), service);
    }
    for (const m of p.members) {
      const appointment = q.appointments.find((a) => a.bookingId.equals(m.bookingId));
      const service = services.get(m.serviceId.toHexString());
      const entitlement = service && resolvePackageServiceEntitlement(service);
      if (
        !appointment ||
        !entitlement ||
        appointment.timing.baseDurationMin !== entitlement.durationMin ||
        appointment.timing.processingTimeMin !== (entitlement.processingTimeMin ?? 0) ||
        appointment.timing.bufferAfterMin !== (entitlement.bufferAfterMin ?? 0) ||
        (appointment.location.mode === "AT_BUSINESS_LOCATION" &&
          hashCanonicalPackageCheckoutContent(appointment.location.businessLocation) !==
            hashCanonicalPackageCheckoutContent({
              city: business.address.city,
              area: business.address.area,
              streetName: business.address.streetName,
              streetNumber: business.address.streetNumber,
              floorUnit: business.address.floorUnit,
              aptRoom: business.address.aptRoom,
              ...(Number.isFinite(business.location?.lat) &&
              Number.isFinite(business.location?.lng) &&
              Math.abs(business.location?.lat ?? Infinity) <= 90 &&
              Math.abs(business.location?.lng ?? Infinity) <= 180
                ? { location: { lat: business.location?.lat, lng: business.location?.lng } }
                : {}),
            }))
      )
        throw batchConflict();
      await validateSchedulingLine(
        {
          business,
          serviceId: m.serviceId,
          staffMembershipId: m.staffMembershipId,
          startAt: m.startAt,
          endAt: m.endAt,
          partySize: 1,
          capacityMax: m.group?.capacityMax ?? 1,
          ...(m.group ? { packageGroup: m.group } : {}),
          allowInactive: false,
          fulfilment: appointment.location,
        },
        this.availability,
        session,
      );
    }
    const ordered = [...p.members].sort(
      (a, b) =>
        a.staffMembershipId.toHexString().localeCompare(b.staffMembershipId.toHexString()) ||
        utcToBusinessLocalDate(q.businessTimezone, a.startAt).dateStr.localeCompare(
          utcToBusinessLocalDate(q.businessTimezone, b.startAt).dateStr,
        ) ||
        a.startAt.getTime() - b.startAt.getTime() ||
        a.bookingId.toHexString().localeCompare(b.bookingId.toHexString()),
    );
    const members = [];
    for (const m of ordered) {
      const packageOperation = packageBatchOperation(p, m);
      const operationKey = packageInitialReservationKey(packageOperation);
      const actual = await this.reservations.reserveOrJoin(
        {
          businessId: p.businessId,
          staffMembershipId: m.staffMembershipId,
          serviceId: m.serviceId,
          timezone: q.businessTimezone,
          startAt: m.startAt,
          endAt: m.endAt,
          partySize: 1,
          capacityMax: m.group?.capacityMax ?? 1,
          idempotencyKey: operationKey,
          packageOperation,
        },
        session,
      );
      members.push({ bookingId: m.bookingId, reservationId: actual.reservationId, operationKey });
    }
    for (const m of p.members) {
      const appointment = q.appointments.find((a) => a.bookingId.equals(m.bookingId));
      const item = q.items.find((i) => i.packageItemId.equals(m.packageItemId));
      const allocation = q.financials.appointments.find((a) => a.bookingId.equals(m.bookingId));
      const applied = members.find((a) => a.bookingId.equals(m.bookingId));
      const staff = await StaffMembershipModel.findById(m.staffMembershipId)
        .session(session)
        .orFail();
      const profile = await UserProfileModel.findOne({ userId: staff.userId }).session(session);
      if (!appointment || !item || !allocation || !applied) throw batchConflict();
      await new BookingRepository().create(
        {
          _id: m.bookingId,
          businessId: p.businessId,
          reference: m.reference,
          source: "BOOKLY_MANAGED",
          status: "UPCOMING",
          customer: {
            businessClientId: p.businessClientId,
            customerUserId: p.customerUserId,
            contact: {
              firstName: client.firstName,
              ...(client.lastName ? { lastName: client.lastName } : {}),
              normalizedEmail: client.normalizedEmail,
              phone: client.phone,
            },
          },
          createdBy: { actorUserId: p.customerUserId, actorRole: "CUSTOMER" },
          fulfilment: appointment.location,
          schedule: { timezone: q.businessTimezone, startAt: m.startAt, endAt: m.endAt },
          serviceLines: [
            {
              serviceId: m.serviceId,
              responsibleStaffMembershipId: m.staffMembershipId,
              ...(profile
                ? { staffSnapshot: { firstName: profile.firstName, lastName: profile.lastName } }
                : {}),
              serviceSnapshot: {
                name: item.serviceName,
                pricingMode: "PACKAGE",
                durationMin: item.baseDurationMin,
              },
              pricingInput: {
                packageProgressId: p.packageProgressId,
                packageItemId: m.packageItemId,
              },
              packageContext: {
                packageId: q.packageId,
                packageName: q.packageName,
                definitionItemId: m.definitionItemId,
                role: "PURCHASE",
              },
              schedulingSnapshot: { ...appointment.timing, ...(m.group ? { group: m.group } : {}) },
              addons: appointment.addons.map((a) => ({ ...a })),
              amountCents: allocation.includedBaseCents,
              reservationId: applied.reservationId,
              reservationOperationKey: applied.operationKey,
            },
          ],
          financials: {
            currency: "EUR",
            servicesSubtotalCents: allocation.includedBaseCents,
            addonsSubtotalCents: allocation.addonsCents,
            serviceDiscountCents: 0,
            travelFeeCents: allocation.travelCents,
            eligiblePlatformFeeBasisCents: allocation.includedBaseCents + allocation.addonsCents,
            platformFeeCents: 0,
            depositCents: 0,
            balanceDueCents:
              allocation.includedBaseCents + allocation.addonsCents + allocation.travelCents,
            totalCents:
              allocation.includedBaseCents + allocation.addonsCents + allocation.travelCents,
          },
          ...(q.policy.cancellation
            ? {
                cancellationPolicySnapshot: {
                  noShowPercentage: q.policy.cancellation.noShowPercentage,
                  tiers: q.policy.cancellation.tiers.map(({ tier, mode, percentage }) => ({
                    tier,
                    mode,
                    ...(percentage !== undefined ? { percentage } : {}),
                  })),
                },
              }
            : {}),
          ...(q.policy.noShowWindow ? { noShowEligibilitySnapshot: q.policy.noShowWindow } : {}),
          ...(row.packageBatchFinance
            ? {
                sessionEndReminderSnapshot: {
                  enabled:
                    services.get(m.serviceId.toHexString())?.sessionExpiryAlert.enabled ?? false,
                  ...(services.get(m.serviceId.toHexString())?.sessionExpiryAlert
                    .minutesBeforeSessionEnds !== undefined
                    ? {
                        minutesBeforeSessionEnds: services.get(m.serviceId.toHexString())
                          ?.sessionExpiryAlert.minutesBeforeSessionEnds,
                      }
                    : {}),
                },
              }
            : {}),
          customerRescheduleCount: 0,
          rescheduleHistory: [],
          eventHistory: [
            {
              type: "CREATED",
              nextStatus: "UPCOMING",
              actorUserId: p.customerUserId,
              actorRole: "CUSTOMER",
              createdAt: p.materializedAt,
            },
          ],
        },
        session,
      );
    }
    const expiresAt = validatePackageActivationDeadline(
      q.validity,
      p.materializedAt,
      p.members.map((m) => m.startAt),
    );
    const pricing = calculatePackagePricing(definition.items, definition.bundlePriceCents);
    const validity = {
      contractVersion: 1,
      mode: q.validity.mode,
      purchasedAt: p.materializedAt,
      activationId: p.activationId,
      batchId: p.batchId,
      ...(q.validity.mode === "FINITE"
        ? {
            months: q.validity.months,
            timezone: q.validity.timezone,
            expiresAt,
            calculation: { version: 1, provenanceRef: q.validity.guaranteeProofRef },
            activationWindow: {
              version: 1,
              quoteId: p.quoteId,
              batchId: p.batchId,
              notBefore: q.validity.activationNotBefore,
              notAfterExclusive: q.validity.activationNotAfterExclusive,
            },
            expiryDisclosure: {
              version: 1,
              quoteId: p.quoteId,
              acceptedTermsPayloadId: accepted.evidence.acceptedTermsPayloadId,
              acceptedTermsHash: p.termsHash,
              guaranteedNotBeforeExpiry: q.validity.guaranteedNotBeforeExpiry,
            },
          }
        : {}),
    };
    const input = packageProgressV2InputSchema.parse({
      _id: p.packageProgressId,
      schemaVersion: 2,
      creditAccountingVersion: 2,
      businessId: p.businessId,
      customerUserId: p.customerUserId,
      businessClientId: p.businessClientId,
      packageId: q.packageId,
      originBookingId: p.originBookingId,
      purchaseSnapshot: {
        name: q.packageName,
        packageRevision: q.definitionRevision,
        bundlePriceCents: q.financials.bundlePriceCents,
        referenceTotalCents: pricing.referenceTotalCents,
        discountPercent: pricing.discountPercent,
        currency: "EUR",
        fulfilmentMode: business.visitType,
      },
      items: q.items.map((i) => ({
        packageItemId: i.packageItemId,
        definitionItemId: i.definitionItemId,
        serviceId: i.serviceId,
        serviceSnapshot: {
          name: i.serviceName,
          pricingMode: i.group ? "PER_PERSON" : "FIXED",
          durationMin: i.baseDurationMin,
          ...(i.group ? { group: i.group } : {}),
        },
        ...(i.travelEntitlement
          ? { travelCities: i.travelEntitlement.cities.map((c) => ({ ...c })) }
          : {}),
        totalSessions: i.totalSessions,
        remainingSessions:
          i.totalSessions - p.members.filter((m) => m.packageItemId.equals(i.packageItemId)).length,
        completedSessions: 0,
        expiredSessions: 0,
        referenceUnitPriceCents: i.referenceUnitPriceCents,
        penaltyBasisCents: i.penaltyBasisCents,
      })),
      sessions: p.members.map((m) => ({
        bookingId: m.bookingId,
        packageItemId: m.packageItemId,
        serviceId: m.serviceId,
        status: "SCHEDULED",
      })),
      purchasedContract: {
        contractVersion: 1,
        definition: {
          packageId: q.packageId,
          packageRevision: q.definitionRevision,
          contractTerms: q.definitionTerms,
        },
        validity,
        penalty: q.penalty,
        acceptance: accepted.evidence,
        activation: {
          version: 1,
          contractVersion: 1,
          activationId: p.activationId,
          activationEventId: p.activationEventId,
          batchId: p.batchId,
          packageProgressId: p.packageProgressId,
          businessId: p.businessId,
          customerUserId: p.customerUserId,
          packageId: q.packageId,
          packageRevision: q.definitionRevision,
          acceptanceId: p.acceptanceId,
          purchasedAt: p.materializedAt,
          provenance: "WINNING_BATCH_ACTIVATION_EVENT",
        },
      },
    });
    await new PackageProgressV2Repository().create(input, session);
    await commitInternalPackageBatch(
      scope,
      token,
      {
        version: 1,
        state: "INTERNAL_MATERIALIZATION_ONLY",
        commercialCompletion: "NOT_ESTABLISHED",
        preparationHash: hashCanonicalPackageCheckoutContent(p),
        members,
      },
      session,
    );
  }
}
