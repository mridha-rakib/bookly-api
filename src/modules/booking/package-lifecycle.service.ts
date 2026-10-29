import mongoose, { type ClientSession, Types } from "mongoose";
import { AppointmentReminderModel } from "../appointment-reminder/appointment-reminder.model.js";
import { AppointmentReminderRepository } from "../appointment-reminder/appointment-reminder.repository.js";
import type { AvailabilityService } from "../availability/availability.service.js";
import { BookingFinancialTransactionModel } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import { BookingFinancialTransactionRepository } from "../booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { BookingSlotReservationService } from "../booking-slot-reservation/booking-slot-reservation.service.js";
import { BookingSlotReservationClaimModel } from "../booking-slot-reservation/booking-slot-reservation-claim.model.js";
import { BusinessModel } from "../business/business.model.js";
import { BusinessClientModel } from "../client/client.model.js";
import { buildBookingEmailData } from "../email/templates/booking/booking-email-data.js";
import { buildBookingRescheduledEmailData } from "../email/templates/booking/booking-rescheduled-customer.template.js";
import { buildCancellationEmailData } from "../email/templates/booking/cancellation-email-data.js";
import { buildNoShowEmailData } from "../email/templates/booking/no-show-email-data.js";
import { buildInvoiceData } from "../email/templates/invoice/invoice-data.js";
import { EmailOutboxModel } from "../email-outbox/email-outbox.model.js";
import { EmailOutboxRepository } from "../email-outbox/email-outbox.repository.js";
import { acquirePackageEligibilityFence } from "../package-progress/package-eligibility.js";
import { PackageProgressV2Model } from "../package-progress/package-progress-v2.model.js";
import { PackageProgressV2Repository } from "../package-progress/package-progress-v2.repository.js";
import { packageProgressV2InputSchema } from "../package-progress/package-progress-v2.rules.js";
import { resolvePackageServiceEntitlement } from "../packages/package-service-entitlement.js";
import type { PaymentService } from "../payment/payment.service.js";
import {
  completeLifecyclePaymentAttempt,
  PaymentAttemptModel,
} from "../payment/payment-attempt.model.js";
import { PaymentAttemptRepository } from "../payment/payment-attempt.repository.js";
import { ServiceModel } from "../services/service.model.js";
import { StaffMembershipModel } from "../staff/staff.model.js";
import { UserModel } from "../user/user.model.js";
import { type BookingDocument, BookingModel } from "./booking.model.js";
import { BookingRepository } from "./booking.repository.js";
import type { BookingService } from "./booking.service.js";
import {
  MAX_CUSTOMER_RESCHEDULE_COUNT,
  NO_SHOW_RESOLUTION_WINDOW_MINUTES,
} from "./booking.types.js";
import { buildCancellationOutcome } from "./booking-cancellation-classification.js";
import { BookingCreationClaimModel } from "./booking-creation-claim.model.js";
import {
  validateSchedulingLine,
  verifiedOccupiedMilliseconds,
} from "./booking-scheduling-admission.js";
import { verifyPackageBatchActivation } from "./package-batch-authority.js";
import { verifyBatchCompletion } from "./package-batch-completion.js";
import {
  batchConflict,
  canonicalPackageBatch,
  PackageBatchUnresolvedError,
} from "./package-batch-contract.js";
import { hashCanonicalPackageCheckoutContent as digest } from "./package-checkout-binding.js";
import {
  type PackageCheckoutCustomer,
  readPackageCheckoutCustomer,
} from "./package-checkout-customer-authority.js";
import {
  type LifecycleIntent,
  type LifecycleResult,
  lifecycleAssessmentSchema,
  lifecycleIntentSchema,
  lifecycleOperationId,
  PackageLifecycleOperationModel,
  PackageLifecycleOperations,
  readLifecycleResult,
} from "./package-lifecycle-operation.js";
import { inspectLifecyclePaymentAuthority } from "./package-lifecycle-payment-recovery.js";
import {
  deriveLifecycleSessionTerms,
  lifecycleSessionAcceptanceSchema,
  lifecycleSessionQuoteSchema,
} from "./package-lifecycle-session-terms.js";

export class PackageLifecyclePaymentPendingError extends Error {
  readonly code = "PACKAGE_LIFECYCLE_PAYMENT_PENDING";
  readonly statusCode = 503;
  constructor(
    readonly providerStatus: string,
    readonly paymentAttemptId: string | undefined,
    readonly clientSecret?: string,
  ) {
    super("Original Package session payment remains pending");
  }
}

type Request = Omit<LifecycleIntent, "version" | "actorUserId" | "actorRole" | "customerUserId">;
/** Unregistered preparation-only lifecycle. All entry points deny before DB work while B1c
 * is unresolved. Existing V2 owns credits; this service composes Booking/effects/intents. */
export class PackageLifecycleService {
  public constructor(
    private readonly availability: AvailabilityService,
    private readonly reservations: BookingSlotReservationService,
    private readonly management: BookingService,
    private readonly clock: () => Date = () => new Date(),
    private readonly payments?: PaymentService,
  ) {}
  public async customer(customer: PackageCheckoutCustomer, request: Request) {
    await verifyPackageBatchActivation();
    const actor = readPackageCheckoutCustomer(customer);
    if (!["REDEEM", "RESCHEDULE", "CANCEL", "EXPIRE"].includes(request.action))
      throw batchConflict();
    return this.#execute(
      lifecycleIntentSchema.parse({
        ...request,
        version: 1,
        actorUserId: actor.userId,
        actorRole: "CUSTOMER",
        customerUserId: actor.userId,
      }),
    );
  }
  /** Read-only recovery of one exact Customer redemption after a lost response or reload. */
  public async customerRedemptionStatus(customer: PackageCheckoutCustomer, request: Request) {
    if (request.action !== "REDEEM") throw batchConflict();
    return this.customerOperationStatus(customer, request);
  }
  /** Read-only recovery of one exact Customer lifecycle operation (REDEEM, RESCHEDULE, CANCEL,
   * EXPIRE) after a lost response or reload. It never prepares, claims, charges, refunds,
   * reserves, releases or writes. The stored operation must carry the identical intent (same
   * action, key, Business, BusinessClient, Progress, Customer actor and action fields); an
   * absent or differently bound operation, including another action's key, returns null, so it
   * is indistinguishable from a missing one. COMPLETE is reported only after the same
   * committed-result verifier the replay path uses; anything else stays UNRESOLVED. */
  public async customerOperationStatus(customer: PackageCheckoutCustomer, request: Request) {
    await verifyPackageBatchActivation();
    const actor = readPackageCheckoutCustomer(customer);
    if (!["REDEEM", "RESCHEDULE", "CANCEL", "EXPIRE"].includes(request.action))
      throw batchConflict();
    const intent = lifecycleIntentSchema.parse({
      ...request,
      version: 1,
      actorUserId: actor.userId,
      actorRole: "CUSTOMER",
      customerUserId: actor.userId,
    });
    return this.#operationStatus(intent);
  }
  /** Read-only recovery of one exact Owner/Supervisor lifecycle operation (every management
   * action: RESCHEDULE, CANCEL, COMPLETE, MARK_NO_SHOW, NO_SHOW, REVERSE_NO_SHOW, EXPIRE,
   * VENUE_SETTLEMENT). The caller must still be the ACTIVE user in that role with current
   * management access to the Business (same checks as business()), and the stored intent must
   * name this exact actor: a Supervisor cannot read the Owner's operation or vice versa, and a
   * Customer operation never matches. No write, notification, payment, settlement or ledger
   * effect; settlement is COMMITTED only with the verifier's exact venue-ledger proof. */
  public async businessOperationStatus(
    actorUserId: Types.ObjectId,
    actorRole: "BUSINESS_OWNER" | "SUPERVISOR",
    customerUserId: Types.ObjectId,
    request: Request,
  ) {
    await verifyPackageBatchActivation();
    if (request.action === "REDEEM") throw batchConflict();
    const user = await UserModel.findById(actorUserId);
    if (!user || user.role !== actorRole || user.status !== "ACTIVE") throw batchConflict();
    await this.management.requireBookingManagementAccess(
      String(actorUserId),
      actorRole,
      String(request.businessId),
    );
    return this.#operationStatus(
      lifecycleIntentSchema.parse({
        ...request,
        version: 1,
        actorUserId,
        actorRole,
        customerUserId,
      }),
    );
  }
  async #operationStatus(intent: LifecycleIntent) {
    const row = await PackageLifecycleOperationModel.findById(lifecycleOperationId(intent.key))
      .read("primary")
      .readConcern("majority")
      .maxTimeMS(2000);
    if (!row || digest(row.intent) !== digest(intent)) return null;
    if (row.phase === "FAILED_FINAL") throw batchConflict();
    if (row.phase !== "COMPLETE") return { state: "UNRESOLVED" as const };
    try {
      const committed = await verifyCommittedLifecycleResult(row._id, intent);
      return committed
        ? { state: "COMMITTED" as const, result: committed.result }
        : { state: "UNRESOLVED" as const };
    } catch {
      // Contradictory or unavailable proof is never reported as success.
      return { state: "UNRESOLVED" as const };
    }
  }
  public async business(
    actorUserId: Types.ObjectId,
    actorRole: "BUSINESS_OWNER" | "SUPERVISOR",
    customerUserId: Types.ObjectId,
    request: Request,
  ) {
    await verifyPackageBatchActivation();
    if (request.action === "REDEEM") throw batchConflict();
    const user = await UserModel.findById(actorUserId);
    if (!user || user.role !== actorRole || user.status !== "ACTIVE") throw batchConflict();
    await this.management.requireBookingManagementAccess(
      String(actorUserId),
      actorRole,
      String(request.businessId),
    );
    return this.#execute(
      lifecycleIntentSchema.parse({
        ...request,
        version: 1,
        actorUserId,
        actorRole,
        customerUserId,
      }),
    );
  }
  async #execute(intent: LifecycleIntent) {
    if (intent.dues && (intent.action !== "REDEEM" || intent.actorRole !== "CUSTOMER"))
      throw batchConflict();
    if (
      intent.venuePayment &&
      (intent.actorRole === "CUSTOMER" || !["COMPLETE", "VENUE_SETTLEMENT"].includes(intent.action))
    )
      throw batchConflict();
    if (intent.action === "VENUE_SETTLEMENT" && !intent.venuePayment) throw batchConflict();
    const operations = new PackageLifecycleOperations();
    const retained = await operations.prepare(intent);
    if (retained.phase === "COMPLETE") return this.#read(retained._id, intent);
    if (intent.dues) {
      const q = lifecycleSessionQuoteSchema.parse(retained.sessionQuote),
        a = lifecycleSessionAcceptanceSchema.parse(retained.sessionAcceptance);
      if (
        !a.customerUserId.equals(intent.customerUserId) ||
        !a.quoteId.equals(q.quoteId) ||
        a.termsHash !== q.termsHash ||
        a.disclosureHash !== q.disclosureHash ||
        a.sessionFamilyId !== q.sessionFamilyId ||
        q.termsHash !== digest(q.terms) ||
        q.terms.intentHash !== digest(intent) ||
        q.disclosureHash !== digest(q.disclosure)
      )
        throw batchConflict();
    }
    if (retained.phase === "PERSISTING") return this.#resolve(retained._id, intent);
    if (retained.phase === "FAILED_FINAL") throw batchConflict();
    const assessment =
      this.payments &&
      (intent.action === "NO_SHOW" ||
        (intent.action === "CANCEL" && intent.actorRole === "CUSTOMER"))
        ? await operations.reservePenalty(retained._id, intent, this.clock())
        : retained.assessment
          ? lifecycleAssessmentSchema.parse(retained.assessment)
          : undefined;
    const attempts = new PaymentAttemptRepository();
    let paid:
      | { attemptId: Types.ObjectId; paymentIntentId: string; token: string; amountCents: number }
      | undefined;
    if (assessment && assessment.amountCents > 0) {
      const moneyBookingId = intent.action === "REDEEM" ? retained.bookingId : intent.bookingId;
      if (!this.payments || !moneyBookingId) throw batchConflict();
      const charge = await this.payments.chargePackageLifecycle({
        version: 1,
        operationId: String(retained._id),
        intentHash: digest(intent),
        businessId: String(intent.businessId),
        businessClientId: String(intent.businessClientId),
        customerUserId: String(intent.customerUserId),
        packageProgressId: String(intent.packageProgressId),
        bookingId: String(moneyBookingId),
        kind: assessment.kind,
        amountCents: assessment.amountCents,
        currency: "EUR",
      });
      if (charge.status === "canceled" && charge.paymentAttemptId) {
        await operations.releaseUncollected(new Types.ObjectId(charge.paymentAttemptId));
        throw batchConflict();
      }
      if (charge.status !== "succeeded" || !charge.paymentAttemptId)
        throw new PackageLifecyclePaymentPendingError(
          charge.status,
          charge.paymentAttemptId,
          assessment.kind === "SESSION_DUES" && intent.actorRole === "CUSTOMER"
            ? charge.clientSecret
            : undefined,
        );
      const paymentToken = await attempts.claimPersistence(charge.paymentAttemptId);
      if (!paymentToken) return this.#resolve(retained._id, intent);
      paid = {
        attemptId: new Types.ObjectId(charge.paymentAttemptId),
        paymentIntentId: charge.paymentIntentId,
        token: paymentToken,
        amountCents: assessment.amountCents,
      };
    }
    const claimed = await operations.claim(retained._id);
    if (!claimed?.token) return this.#resolve(retained._id, intent);
    const token = claimed.token;
    const session = await mongoose.startSession();
    let returned = false;
    try {
      await session.withTransaction(async () => {
        returned = false;
        await acquirePackageEligibilityFence(intent.businessId, session);
        const operation = await PackageLifecycleOperationModel.findOne({
          _id: retained._id,
          phase: "PERSISTING",
          token,
        }).session(session);
        if (!operation || digest(operation.intent) !== digest(intent)) throw batchConflict();
        const loaded = await new PackageProgressV2Repository(this.clock).findOwned(
          intent.packageProgressId,
          intent.businessId,
          intent.customerUserId,
          session,
        );
        const progress = loaded?.toObject();
        if (
          progress?.creditAccountingVersion !== 2 ||
          !progress.businessClientId.equals(intent.businessClientId)
        )
          throw batchConflict();
        const claim = await BookingCreationClaimModel.findOne({
          "packageBatchPreparation.packageProgressId": progress._id,
          businessId: intent.businessId,
          actorUserId: intent.customerUserId,
        }).session(session);
        if (!claim) throw batchConflict();
        const purchase = await verifyBatchCompletion(claim, session);
        const acceptedQuote = canonicalPackageBatch(claim.toObject()).quote;
        const business = await BusinessModel.findById(intent.businessId).session(session).orFail();
        if (intent.actorRole !== "CUSTOMER") {
          const user = await UserModel.findOne({
            _id: intent.actorUserId,
            role: intent.actorRole,
            status: "ACTIVE",
          }).session(session);
          const allowed =
            intent.actorRole === "BUSINESS_OWNER"
              ? business.ownerUserId.equals(intent.actorUserId)
              : !!(await StaffMembershipModel.exists({
                  businessId: intent.businessId,
                  userId: intent.actorUserId,
                  role: "SUPERVISOR",
                  employmentActive: true,
                  // Same non-removed contract as the shared scope guard/partial unique index.
                  removedAt: null,
                }).session(session));
          if (!user || !allowed) throw batchConflict();
        }
        const now = this.clock();
        if (
          !Number.isFinite(now.getTime()) ||
          now < progress.purchasedContract.validity.purchasedAt
        )
          throw batchConflict();
        const result: LifecycleResult = {
          version: 1,
          status: "EXPIRED",
          committedAt: now,
          emails: [],
          reminders: [],
          tasks: [],
        };
        const credits = new PackageProgressV2Repository(this.clock);
        if (intent.action === "EXPIRE") {
          if (progress.purchasedContract.validity.mode === "FINITE")
            await credits.reconcileExpiry(
              progress._id,
              intent.businessId,
              intent.customerUserId,
              session,
            );
          else result.status = "FOREVER";
        } else {
          let booking: BookingDocument;
          if (intent.action === "REDEEM") {
            if (
              !intent.packageItemId ||
              !intent.staffMembershipId ||
              !intent.startAt ||
              !operation.bookingId ||
              intent.bookingId
            )
              throw batchConflict();
            const requestedItemId = intent.packageItemId;
            const item = progress.items.find((i) => i.packageItemId.equals(requestedItemId));
            const original = purchase.bookings.find((b) => b._id.equals(progress.originBookingId));
            if (!original || original.schedule.timezone !== business.timezone)
              throw batchConflict();
            if (
              !item ||
              item.remainingSessions < 1 ||
              progress.voidedAt ||
              (progress.purchasedContract.validity.mode === "FINITE" &&
                (now >= progress.purchasedContract.validity.expiresAt ||
                  intent.startAt >= progress.purchasedContract.validity.expiresAt)) ||
              intent.startAt <= now
            )
              throw batchConflict();
            // No later-session charge/accepted-payment authority exists yet. Do not infer one
            // from the original Package PI or silently apply today's travel/add-on prices.
            if (progress.purchaseSnapshot.fulfilmentMode === "TRAVEL_TO_CUSTOMER" && !intent.dues)
              throw new Error("PACKAGE_LIFECYCLE_CHARGE_AUTHORITY_REQUIRED");
            const client = await BusinessClientModel.findOneAndUpdate(
              {
                _id: intent.businessClientId,
                businessId: intent.businessId,
                linkedUserId: intent.customerUserId,
              },
              { $inc: { __v: 1 } },
              { session, returnDocument: "after", timestamps: false },
            );
            if (!client) throw batchConflict();
            const service = await ServiceModel.findOne({
              _id: item.serviceId,
              businessId: intent.businessId,
            })
              .session(session)
              .orFail();
            const entitlement = resolvePackageServiceEntitlement(service);
            if (
              !entitlement ||
              service.pricingMode !== item.serviceSnapshot.pricingMode ||
              digest(entitlement.group ?? null) !== digest(item.serviceSnapshot.group ?? null)
            )
              throw batchConflict();
            const buffer = entitlement.bufferAfterMin ?? 0,
              processing = entitlement.processingTimeMin ?? 0;
            const duration = item.serviceSnapshot.durationMin + buffer + processing;
            const endAt = new Date(intent.startAt.getTime() + duration * 60000);
            const sessionTerms = intent.dues
              ? await deriveLifecycleSessionTerms(intent, operation.bookingId, session, now)
              : undefined;
            if (sessionTerms) {
              const q = lifecycleSessionQuoteSchema.parse(operation.sessionQuote),
                a = lifecycleSessionAcceptanceSchema.parse(operation.sessionAcceptance);
              if (
                digest(sessionTerms) !== q.termsHash ||
                a.termsHash !== q.termsHash ||
                a.disclosureHash !== q.disclosureHash ||
                !a.customerUserId.equals(intent.customerUserId)
              )
                throw batchConflict();
              if (
                sessionTerms.paymentMethod === "ONLINE" &&
                sessionTerms.totalCents > 0 &&
                (!paid || paid.amountCents !== sessionTerms.totalCents)
              )
                throw batchConflict();
            }
            const fulfilment = sessionTerms?.fulfilment ?? original.fulfilment;
            const key = `bookly:package-redemption:v1:${intent.businessId}:${operation.bookingId}`;
            await validateSchedulingLine(
              {
                business,
                serviceId: item.serviceId,
                staffMembershipId: intent.staffMembershipId,
                startAt: intent.startAt,
                endAt,
                partySize: 1,
                capacityMax: item.serviceSnapshot.group?.capacityMax ?? 1,
                packageGroup: item.serviceSnapshot.group,
                allowInactive: true,
                fulfilment,
              },
              this.availability,
              session,
            );
            // Entitlement and balance checks occur before occupancy; both roll back on failure.
            await credits.claim(
              { ...intent, serviceId: item.serviceId, packageItemId: item.packageItemId },
              operation.bookingId,
              session,
            );
            const actual = await this.reservations.reserveOrJoin(
              {
                businessId: intent.businessId,
                staffMembershipId: intent.staffMembershipId,
                serviceId: item.serviceId,
                timezone: business.timezone,
                startAt: intent.startAt,
                endAt,
                partySize: 1,
                capacityMax: item.serviceSnapshot.group?.capacityMax ?? 1,
                idempotencyKey: key,
              },
              session,
            );
            booking = await new BookingRepository().create(
              {
                _id: operation.bookingId,
                businessId: intent.businessId,
                reference: `S5${operation.bookingId.toHexString().toUpperCase()}`,
                source: "BOOKLY_MANAGED",
                status: "UPCOMING",
                customer: {
                  businessClientId: intent.businessClientId,
                  customerUserId: intent.customerUserId,
                  contact: {
                    firstName: client.firstName,
                    ...(client.lastName ? { lastName: client.lastName } : {}),
                    normalizedEmail: client.normalizedEmail,
                    phone: client.phone,
                  },
                },
                createdBy: { actorUserId: intent.actorUserId, actorRole: "CUSTOMER" },
                fulfilment,
                schedule: { timezone: business.timezone, startAt: intent.startAt, endAt },
                serviceLines: [
                  {
                    serviceId: item.serviceId,
                    responsibleStaffMembershipId: intent.staffMembershipId,
                    serviceSnapshot: {
                      name: item.serviceSnapshot.name,
                      pricingMode: "PACKAGE",
                      durationMin: item.serviceSnapshot.durationMin,
                    },
                    pricingInput: {
                      packageProgressId: progress._id,
                      packageItemId: item.packageItemId,
                    },
                    packageContext: {
                      packageId: progress.packageId,
                      packageName: progress.purchaseSnapshot.name,
                      definitionItemId: item.definitionItemId,
                      role: "REDEMPTION",
                    },
                    schedulingSnapshot: {
                      version: 1,
                      baseDurationMin: item.serviceSnapshot.durationMin,
                      bufferAfterMin: buffer,
                      processingTimeMin: processing,
                      occupiedDurationMin: duration,
                      ...(item.serviceSnapshot.group ? { group: item.serviceSnapshot.group } : {}),
                    },
                    addons:
                      sessionTerms?.addons.map(({ addonId, name, priceCents }) => ({
                        addonId,
                        name,
                        priceCents,
                      })) ?? [],
                    amountCents: 0,
                    reservationId: actual.reservationId,
                    reservationOperationKey: key,
                  },
                ],
                financials: {
                  currency: "EUR",
                  servicesSubtotalCents: 0,
                  addonsSubtotalCents: sessionTerms?.addonsCents ?? 0,
                  serviceDiscountCents: 0,
                  travelFeeCents: sessionTerms?.travelCents ?? 0,
                  eligiblePlatformFeeBasisCents: sessionTerms?.addonsCents ?? 0,
                  platformFeeCents: 0,
                  depositCents: paid?.amountCents ?? 0,
                  balanceDueCents: (sessionTerms?.totalCents ?? 0) - (paid?.amountCents ?? 0),
                  totalCents: sessionTerms?.totalCents ?? 0,
                },
                ...(acceptedQuote.policy.cancellation
                  ? {
                      cancellationPolicySnapshot: {
                        noShowPercentage: acceptedQuote.policy.cancellation.noShowPercentage,
                        tiers: acceptedQuote.policy.cancellation.tiers.map(
                          ({ tier, mode, percentage }) => ({
                            tier,
                            mode,
                            ...(percentage !== undefined ? { percentage } : {}),
                          }),
                        ),
                      },
                    }
                  : {}),
                ...(acceptedQuote.policy.noShowWindow
                  ? { noShowEligibilitySnapshot: acceptedQuote.policy.noShowWindow }
                  : {}),
                sessionEndReminderSnapshot: service.sessionExpiryAlert,
                customerRescheduleCount: 0,
                rescheduleHistory: [],
                eventHistory: [
                  {
                    type: "CREATED",
                    actorUserId: intent.actorUserId,
                    actorRole: "CUSTOMER",
                    nextStatus: "UPCOMING",
                    createdAt: now,
                  },
                ],
              },
              session,
            );
            result.startAt = intent.startAt;
            result.effectState = "APPLIED";
            result.reservationKey = key;
            result.reservationId = actual.reservationId;
            result.staffMembershipId = intent.staffMembershipId;
            result.endAt = endAt;
          } else {
            if (!intent.bookingId || (intent.startAt && intent.action !== "RESCHEDULE"))
              throw batchConflict();
            const loadedBooking = await BookingModel.findOne({
              _id: intent.bookingId,
              businessId: intent.businessId,
              "customer.customerUserId": intent.customerUserId,
              "customer.businessClientId": intent.businessClientId,
            })
              .session(session)
              .orFail();
            booking = loadedBooking.toObject();
            if (
              digest(booking.cancellationPolicySnapshot ?? null) !==
                digest(acceptedQuote.policy.cancellation ?? null) ||
              digest(booking.noShowEligibilitySnapshot ?? null) !==
                digest(acceptedQuote.policy.noShowWindow ?? null)
            )
              throw batchConflict();
            const line = booking.serviceLines[0];
            const item = progress.items.find((i) =>
              i.packageItemId.equals(line?.pricingInput.packageItemId ?? new Types.ObjectId()),
            );
            const attempt = progress.sessions.find((a) => a.bookingId.equals(booking._id));
            if (
              booking.serviceLines.length !== 1 ||
              !line ||
              !item ||
              (intent.packageItemId && !intent.packageItemId.equals(item.packageItemId)) ||
              !line.pricingInput.packageProgressId?.equals(progress._id) ||
              !line.serviceId.equals(item.serviceId) ||
              !attempt?.packageItemId.equals(item.packageItemId) ||
              (intent.action !== "VENUE_SETTLEMENT" && attempt.status !== "SCHEDULED") ||
              !attempt.serviceId.equals(item.serviceId)
            )
              throw batchConflict();
            const scope = {
              ...intent,
              packageItemId: item.packageItemId,
              serviceId: item.serviceId,
            };
            if (!line.reservationOperationKey || !line.reservationId) throw batchConflict();
            result.reservationKey = line.reservationOperationKey;
            result.reservationId = line.reservationId;
            result.staffMembershipId = line.responsibleStaffMembershipId;
            result.startAt = booking.schedule.startAt;
            result.endAt = booking.schedule.endAt;
            result.effectState = "APPLIED";
            const previousStatus = booking.status;
            const pendingMoney = await PackageLifecycleOperationModel.find({
              "intent.businessId": intent.businessId,
              "intent.bookingId": booking._id,
              "assessment.state": "RESERVED",
              "assessment.amountCents": { $gt: 0 },
              _id: { $ne: retained._id },
            })
              .session(session)
              .maxTimeMS(2000);
            if (pendingMoney.length) throw batchConflict();
            if (
              assessment &&
              (booking.status !== assessment.bookingStatus ||
                booking.eventHistory.length !== assessment.eventVersion)
            )
              throw batchConflict();
            const release = async () => {
              await this.reservations.release(
                {
                  businessId: booking.businessId,
                  staffMembershipId: line.responsibleStaffMembershipId,
                  timezone: booking.schedule.timezone,
                  startAt: booking.schedule.startAt,
                  reservationId: line.reservationId,
                  partySize: 1,
                  idempotencyKey: line.reservationOperationKey,
                },
                session,
              );
            };
            if (intent.venuePayment) {
              if (
                intent.actorRole === "CUSTOMER" ||
                !["UPCOMING", "COMPLETED"].includes(booking.status)
              )
                throw batchConflict();
              const due = booking.financials.balanceDueCents;
              const paid = booking.completionPayment?.paid
                ? (booking.completionPayment.amountCents ?? 0)
                : 0;
              if (
                !Number.isSafeInteger(due) ||
                !Number.isSafeInteger(paid) ||
                paid < 0 ||
                paid > due
              )
                throw batchConflict();
              const outstanding = due - paid;
              const v = intent.venuePayment;
              if (v.settlement !== "PARTIAL" && v.amountCents !== undefined) throw batchConflict();
              const amount =
                v.settlement === "FULL"
                  ? outstanding
                  : v.settlement === "NOT_PAID"
                    ? 0
                    : v.amountCents;
              if (
                amount === undefined ||
                !Number.isSafeInteger(amount) ||
                amount < 0 ||
                amount > outstanding ||
                (v.settlement === "PARTIAL" && (amount <= 0 || amount >= outstanding)) ||
                (v.settlement === "NOT_PAID" && paid > 0) ||
                (v.settlement === "FULL" && outstanding === 0 && paid > 0)
              )
                throw batchConflict();
              const cumulative = paid + amount;
              booking.completionPayment = {
                paid: cumulative > 0,
                ...(cumulative > 0 ? { amountCents: cumulative } : {}),
                ...(v.note ? { note: v.note } : {}),
                recordedAt: now,
                recordedBy: intent.actorUserId,
              };
              result.venue = { amountCents: amount, cumulativeCents: cumulative };
              if (amount > 0) {
                const ledger = await new BookingFinancialTransactionService(
                  new BookingFinancialTransactionRepository(),
                ).record(
                  {
                    businessId: intent.businessId,
                    bookingId: booking._id,
                    businessClientId: intent.businessClientId,
                    customerUserId: intent.customerUserId,
                    type: "PAYMENT",
                    direction: "DEBIT",
                    amountCents: amount,
                    currency: "EUR",
                    status: "SUCCEEDED",
                    idempotencyKey: `package-venue:${retained._id}`,
                    metadata: {
                      collectedAtVenue: true,
                      lifecycleOperationId: String(retained._id),
                    },
                  },
                  session,
                );
                result.venue.ledgerId = ledger._id;
              }
            }
            if (intent.action === "VENUE_SETTLEMENT") {
              // Attestation changes no appointment status, credit or reservation.
            } else if (intent.action === "RESCHEDULE") {
              if (
                booking.status !== "UPCOMING" ||
                !intent.startAt ||
                intent.startAt <= now ||
                (intent.actorRole === "CUSTOMER" &&
                  booking.customerRescheduleCount >= MAX_CUSTOMER_RESCHEDULE_COUNT) ||
                booking.schedule.timezone !== business.timezone ||
                (progress.purchasedContract.validity.mode === "FINITE" &&
                  (now >= progress.purchasedContract.validity.expiresAt ||
                    intent.startAt >= progress.purchasedContract.validity.expiresAt))
              )
                throw batchConflict();
              const occupied = await verifiedOccupiedMilliseconds(booking, line, session);
              const endAt = new Date(intent.startAt.getTime() + occupied.duration);
              const staff = intent.staffMembershipId ?? line.responsibleStaffMembershipId;
              // Existing reschedule authority moves time, not a silent provider reassignment.
              if (!staff.equals(line.responsibleStaffMembershipId)) throw batchConflict();
              await validateSchedulingLine(
                {
                  business,
                  serviceId: line.serviceId,
                  staffMembershipId: staff,
                  startAt: intent.startAt,
                  endAt,
                  partySize: 1,
                  capacityMax: occupied.capacityMax,
                  packageGroup: line.schedulingSnapshot?.group,
                  allowInactive: line.packageContext?.role === "REDEMPTION",
                  existingAppointment: true,
                  fulfilment: booking.fulfilment,
                },
                this.availability,
                session,
              );
              const key = `bookly:package-move:v1:${intent.businessId}:${retained._id}`;
              const actual = await this.reservations.reserveOrJoin(
                {
                  businessId: intent.businessId,
                  staffMembershipId: staff,
                  serviceId: line.serviceId,
                  timezone: booking.schedule.timezone,
                  startAt: intent.startAt,
                  endAt,
                  partySize: 1,
                  capacityMax: occupied.capacityMax,
                  idempotencyKey: key,
                },
                session,
              );
              await release();
              booking.rescheduleHistory.push({
                actorUserId: intent.actorUserId,
                actorRole: intent.actorRole,
                previousStart: booking.schedule.startAt,
                previousEnd: booking.schedule.endAt,
                newStart: intent.startAt,
                newEnd: endAt,
                countedTowardCustomerQuota: intent.actorRole === "CUSTOMER",
                createdAt: now,
              });
              booking.schedule.startAt = intent.startAt;
              booking.schedule.endAt = endAt;
              line.reservationId = actual.reservationId;
              line.reservationOperationKey = key;
              line.responsibleStaffMembershipId = staff;
              if (intent.actorRole === "CUSTOMER") booking.customerRescheduleCount++;
              result.startAt = intent.startAt;
              result.effectState = "APPLIED";
              result.reservationKey = key;
              result.reservationId = actual.reservationId;
              result.staffMembershipId = staff;
              result.endAt = endAt;
            } else if (intent.action === "MARK_NO_SHOW") {
              const window = booking.noShowEligibilitySnapshot;
              if (
                intent.actorRole === "CUSTOMER" ||
                booking.status !== "UPCOMING" ||
                !window ||
                now.getTime() <
                  booking.schedule.startAt.getTime() + window.opensAfterMinutes * 60000 ||
                now.getTime() >=
                  booking.schedule.startAt.getTime() + window.closesAfterMinutes * 60000
              )
                throw batchConflict();
              booking.status = "PENDING";
              booking.noShowStartedAt = now;
              booking.noShowDeadlineAt = new Date(
                now.getTime() + NO_SHOW_RESOLUTION_WINDOW_MINUTES * 60000,
              );
            } else if (intent.action === "COMPLETE") {
              if (intent.actorRole === "CUSTOMER" || booking.status !== "UPCOMING")
                throw batchConflict();
              booking.status = "COMPLETED";
              await credits.resolveWithResult(scope, booking._id, "COMPLETED", session);
            } else {
              if (intent.action === "CANCEL") {
                if (booking.status !== "UPCOMING") throw batchConflict();
                const classified = buildCancellationOutcome({
                  scheduledStartAt: booking.schedule.startAt,
                  now: assessment?.assessedAt ?? now,
                  policySnapshot: booking.cancellationPolicySnapshot,
                  eligiblePlatformFeeBasisCents: item.penaltyBasisCents,
                  depositAlreadyPaidCents: 0,
                });
                const late = intent.actorRole === "CUSTOMER" && classified.feeMode === "PERCENTAGE";
                if (
                  late &&
                  classified.cancellationFeeCents > 0 &&
                  progress.purchasedContract.penalty.lifetimeCapCents > 0 &&
                  !assessment
                )
                  throw new Error("PACKAGE_LIFECYCLE_PENALTY_AUTHORITY_REQUIRED");
                booking.status = late
                  ? "LATE_CANCELLATION"
                  : intent.actorRole === "CUSTOMER"
                    ? "CANCELLED_BY_CUSTOMER"
                    : "CANCELLED_BY_BUSINESS";
                booking.cancellationOutcome = {
                  ...classified,
                  cancellationFeeCents: assessment?.amountCents ?? 0,
                  depositAppliedCents: 0,
                  additionalChargeCents: assessment?.amountCents ?? 0,
                  refundOwedCents: 0,
                  settlementStatus: paid ? "SUCCEEDED" : "NOT_APPLICABLE",
                  ...(intent.actorRole !== "CUSTOMER" ? { feeMode: "FREE" as const } : {}),
                };
                await release();
                result.effectState = "RELEASED";
                await credits.resolveWithResult(
                  scope,
                  booking._id,
                  late ? "FORFEITED" : "CANCELLED",
                  session,
                );
              } else {
                if (intent.actorRole === "CUSTOMER" || booking.status !== "PENDING")
                  throw batchConflict();
                if (intent.action === "NO_SHOW") {
                  if (!booking.noShowDeadlineAt || now < booking.noShowDeadlineAt)
                    throw batchConflict();
                  if (
                    item.penaltyBasisCents > 0 &&
                    progress.purchasedContract.penalty.lifetimeCapCents > 0 &&
                    !assessment
                  )
                    throw new Error("PACKAGE_LIFECYCLE_PENALTY_AUTHORITY_REQUIRED");
                  booking.status = paid ? "NO_SHOW_CHARGED" : "NO_SHOW_WAIVED";
                } else if (intent.action === "REVERSE_NO_SHOW")
                  booking.status = "NO_SHOW_CANCELLED";
                else throw batchConflict();
                // Existing no-show lifecycle keeps occupancy as immutable history.
                await credits.resolveWithResult(
                  scope,
                  booking._id,
                  intent.action === "NO_SHOW" ? "FORFEITED" : "CANCELLED",
                  session,
                );
              }
            }
            booking.eventHistory.push({
              type: intent.action === "RESCHEDULE" ? "RESCHEDULED" : "STATUS_CHANGED",
              previousStatus,
              nextStatus: booking.status,
              actorUserId: intent.actorUserId,
              actorRole: intent.actorRole,
              createdAt: now,
            });
            const updated = await BookingModel.updateOne(
              { _id: booking._id, status: previousStatus },
              {
                $set: {
                  status: booking.status,
                  schedule: booking.schedule,
                  serviceLines: booking.serviceLines,
                  rescheduleHistory: booking.rescheduleHistory,
                  customerRescheduleCount: booking.customerRescheduleCount,
                  eventHistory: booking.eventHistory,
                  ...(intent.venuePayment ? { completionPayment: booking.completionPayment } : {}),
                  ...(booking.cancellationOutcome
                    ? { cancellationOutcome: booking.cancellationOutcome }
                    : {}),
                  ...(booking.noShowStartedAt
                    ? {
                        noShowStartedAt: booking.noShowStartedAt,
                        noShowDeadlineAt: booking.noShowDeadlineAt,
                      }
                    : {}),
                },
              },
              { session, runValidators: true },
            );
            if (updated.modifiedCount !== 1) throw batchConflict();
          }
          if (paid) {
            const ledger = await new BookingFinancialTransactionService(
              new BookingFinancialTransactionRepository(),
            ).record(
              {
                businessId: intent.businessId,
                bookingId: booking._id,
                businessClientId: intent.businessClientId,
                customerUserId: intent.customerUserId,
                type:
                  assessment?.kind === "SESSION_DUES"
                    ? "PAYMENT"
                    : assessment?.kind === "NO_SHOW_FEE"
                      ? "NO_SHOW_FEE"
                      : "CANCELLATION_FEE",
                direction: "DEBIT",
                amountCents: paid.amountCents,
                currency: "EUR",
                status: "SUCCEEDED",
                providerReference: paid.paymentIntentId,
                idempotencyKey: `package-session-charge:${retained._id}`,
                metadata: {
                  lifecycleOperationId: String(retained._id),
                  independentPackagePenalty: assessment?.kind !== "SESSION_DUES",
                },
              },
              session,
            );
            result.money = {
              attemptId: paid.attemptId,
              ledgerId: ledger._id,
              amountCents: paid.amountCents,
              paymentIntentId: paid.paymentIntentId,
            };
          }
          result.bookingId = booking._id;
          result.status = booking.status;
          if (intent.action !== "VENUE_SETTLEMENT")
            await this.#delivery(intent, booking, business.name, result, session);
        }
        await operations.complete(retained._id, token, result, session);
        if (paid && !(await completeLifecyclePaymentAttempt(paid.attemptId, paid.token, session)))
          throw batchConflict();
        returned = true;
      });
    } catch (error) {
      const unknown =
        returned ||
        (typeof error === "object" &&
          error !== null &&
          (("hasErrorLabel" in error &&
            typeof error.hasErrorLabel === "function" &&
            error.hasErrorLabel("UnknownTransactionCommitResult")) ||
            ("errorLabels" in error &&
              Array.isArray(error.errorLabels) &&
              error.errorLabels.includes("UnknownTransactionCommitResult"))));
      if (unknown) return this.#resolve(retained._id, intent);
      if (paid && this.payments) {
        if (
          await attempts.markCompensationRequired(
            paid.attemptId,
            "Definite lifecycle transaction abort",
            paid.token,
          )
        ) {
          await operations.failPaid(retained._id, token);
          if (await attempts.claimCompensation(paid.attemptId))
            await this.payments.refund({
              paymentIntentId: paid.paymentIntentId,
              amountCents: paid.amountCents,
              currency: "EUR",
              idempotencyKey: `refund:${paid.paymentIntentId}:compensation`,
              reason: "requested_by_customer",
              domainReason: "BOOKING_PERSISTENCE_COMPENSATION",
              sourcePaymentAttemptId: paid.attemptId,
              bookingId:
                (intent.action === "REDEEM" ? retained.bookingId : intent.bookingId) ?? undefined,
              packageProgressId: intent.packageProgressId,
              businessId: intent.businessId,
              customerUserId: intent.customerUserId,
              businessClientId: intent.businessClientId,
            });
        }
      } else await operations.reset(retained._id, token);
      throw error;
    } finally {
      await session.endSession().catch(() => undefined);
    }
    return this.#resolve(retained._id, intent);
  }
  async #delivery(
    intent: LifecycleIntent,
    booking: BookingDocument,
    businessName: string,
    result: LifecycleResult,
    session: ClientSession,
  ) {
    const reminders = new AppointmentReminderRepository();
    if (intent.action !== "REDEEM")
      await reminders.retireActiveForBooking(
        booking._id,
        `PACKAGE_${intent.action}`,
        { now: this.clock() },
        session,
      );
    if (booking.status === "UPCOMING") {
      const row = await reminders.schedule(
        {
          kind: "REMINDER_24H",
          bookingId: booking._id,
          businessId: booking.businessId,
          customerUserId: intent.customerUserId,
          scheduleStartAt: booking.schedule.startAt,
          now: this.clock(),
        },
        session,
      );
      result.reminders.push(row.record._id);
      const alert = booking.sessionEndReminderSnapshot;
      if (alert?.enabled && alert.minutesBeforeSessionEnds !== undefined)
        result.reminders.push(
          (
            await reminders.schedule(
              {
                kind: "SESSION_END_REMINDER",
                bookingId: booking._id,
                businessId: booking.businessId,
                customerUserId: intent.customerUserId,
                scheduleStartAt: booking.schedule.endAt,
                offsetMinutes: alert.minutesBeforeSessionEnds,
                now: this.clock(),
              },
              session,
            )
          ).record._id,
        );
    }
    let templateKey:
      | "BOOKING_CUSTOMER_CONFIRMED"
      | "BOOKING_RESCHEDULED_CUSTOMER"
      | "BOOKING_CANCELLED_CUSTOMER"
      | "NO_SHOW_CHARGED"
      | "NO_SHOW_WAIVED"
      | "NO_SHOW_CANCELLED"
      | "BOOKING_COMPLETED" = "BOOKING_CUSTOMER_CONFIRMED";
    let payload: object = buildBookingEmailData(booking, {
      businessName,
      includeCustomerBookingLink: true,
    });
    if (intent.action === "RESCHEDULE") {
      templateKey = "BOOKING_RESCHEDULED_CUSTOMER";
      payload = buildBookingRescheduledEmailData(booking, { businessName });
    } else if (intent.action === "CANCEL") {
      templateKey = "BOOKING_CANCELLED_CUSTOMER";
      payload = buildCancellationEmailData(booking, {
        businessName,
        cancelledBy: intent.actorRole === "CUSTOMER" ? "CUSTOMER" : "BUSINESS",
      });
    } else if (intent.action === "COMPLETE") {
      templateKey = "BOOKING_COMPLETED";
      payload = {
        invoice: buildInvoiceData(booking, { businessName }),
        customerBookingUrlPath: `/customer/bookings/view?id=${booking._id}`,
      };
    }
    if (intent.action === "NO_SHOW" || intent.action === "REVERSE_NO_SHOW") {
      templateKey =
        intent.action === "NO_SHOW"
          ? result.money
            ? "NO_SHOW_CHARGED"
            : "NO_SHOW_WAIVED"
          : "NO_SHOW_CANCELLED";
      const itemBasis = result.money
        ? (
            await PackageLifecycleOperationModel.findOne({ "intent.key": intent.key }).session(
              session,
            )
          )?.assessment
        : undefined;
      const a = itemBasis ? lifecycleAssessmentSchema.parse(itemBasis) : undefined;
      payload = buildNoShowEmailData(booking, {
        businessName,
        outcome: intent.action === "NO_SHOW" ? (result.money ? "CHARGED" : "WAIVED") : "CANCELLED",
        ...(result.money && a
          ? {
              amounts: {
                noShowPercentage: booking.cancellationPolicySnapshot?.noShowPercentage ?? 0,
                eligibleBasisCents: a.basisCents,
                grossFeeCents: a.requestedCents,
                upfrontAppliedCents: 0,
                additionalChargeCents: result.money.amountCents,
              },
            }
          : {}),
      });
    }
    // Email outbox plans are committed atomically; uncertain dispatch never changes purchase.
    if (
      ["REDEEM", "RESCHEDULE", "CANCEL", "COMPLETE", "NO_SHOW", "REVERSE_NO_SHOW"].includes(
        intent.action,
      )
    )
      result.emails.push(
        (
          await new EmailOutboxRepository().enqueue(
            {
              eventKey: `PACKAGE_LIFECYCLE:${intent.key}`,
              templateKey,
              recipient: booking.customer.contact.normalizedEmail,
              payload: { ...payload },
            },
            session,
          )
        ).record._id,
      );
    let ownerOutbox: Types.ObjectId | undefined, customerNoticeOutbox: Types.ObjectId | undefined;
    if (intent.action === "REDEEM" || intent.action === "CANCEL") {
      const business = await BusinessModel.findById(booking.businessId).session(session).orFail();
      const owner = await UserModel.findById(business.ownerUserId).session(session);
      if (owner?.normalizedEmail) {
        const plan =
          intent.action === "REDEEM"
            ? {
                templateKey: "BOOKING_OWNER_NEW_BOOKING" as const,
                payload: {
                  ...buildBookingEmailData(booking, {
                    businessName,
                    includeCustomerBookingLink: false,
                  }),
                },
              }
            : {
                templateKey: "BOOKING_CANCELLED_OWNER" as const,
                payload: {
                  ...buildCancellationEmailData(booking, {
                    businessName,
                    cancelledBy: intent.actorRole === "CUSTOMER" ? "CUSTOMER" : "BUSINESS",
                  }),
                },
              };
        const mail = await new EmailOutboxRepository().enqueue(
          {
            eventKey: `PACKAGE_LIFECYCLE:${intent.key}`,
            recipient: owner.normalizedEmail,
            ...plan,
          },
          session,
        );
        ownerOutbox = mail.record._id;
        result.emails.push(ownerOutbox);
      }
    }
    const notices: Record<string, { title: string; message: string }> = {
      REDEEM: {
        title: "Package appointment booked",
        message:
          "One remaining Package credit has been allocated to this appointment. Any accepted session dues are recorded separately from the Package bundle.",
      },
      RESCHEDULE: {
        title: "Package appointment rescheduled",
        message:
          "The appointment time changed. The existing credit remains allocated to the same appointment.",
      },
      CANCEL: {
        title: "Package appointment cancelled",
        message:
          booking.status === "LATE_CANCELLATION"
            ? "The appointment credit was forfeited under the accepted late-cancellation terms."
            : "The appointment was cancelled. Its credit follows the original Package validity.",
      },
      COMPLETE: {
        title: "Package appointment completed",
        message:
          "The appointment was completed and its allocated credit was consumed. Completion alone does not attest venue payment.",
      },
      MARK_NO_SHOW: {
        title: "Package appointment under no-show review",
        message:
          "The Business marked this appointment for no-show review. The review is pending; this notice does not report a collected payment or a forfeited credit.",
      },
      NO_SHOW: {
        title: "Package no-show review resolved",
        message: result.money
          ? `The appointment credit was forfeited. An independent charge of EUR ${(result.money.amountCents / 100).toFixed(2)} succeeded. The original Package upfront was not offset or charged again.`
          : "The appointment credit was forfeited. No additional no-show payment was collected by this resolution.",
      },
      REVERSE_NO_SHOW: {
        title: "Package no-show review reversed",
        message:
          "The no-show review was reversed. Its credit follows the original Package validity; no no-show payment was collected by this operation.",
      },
    };
    const notice = notices[intent.action];
    if (notice && (!ownerOutbox || intent.action === "MARK_NO_SHOW")) {
      const data = { ...notice, businessName, bookingReference: booking.reference };
      const business = await BusinessModel.findById(booking.businessId).session(session).orFail();
      const owner = await UserModel.findById(business.ownerUserId).session(session);
      if (!ownerOutbox && owner?.normalizedEmail) {
        ownerOutbox = (
          await new EmailOutboxRepository().enqueue(
            {
              eventKey: `PACKAGE_LIFECYCLE:${intent.key}`,
              templateKey: "PACKAGE_SESSION_LIFECYCLE",
              recipient: owner.normalizedEmail,
              payload: data,
            },
            session,
          )
        ).record._id;
        result.emails.push(ownerOutbox);
      }
      if (intent.action === "MARK_NO_SHOW" && booking.customer.contact.normalizedEmail) {
        customerNoticeOutbox = (
          await new EmailOutboxRepository().enqueue(
            {
              eventKey: `PACKAGE_LIFECYCLE:${intent.key}`,
              templateKey: "PACKAGE_SESSION_LIFECYCLE",
              recipient: booking.customer.contact.normalizedEmail,
              payload: data,
            },
            session,
          )
        ).record._id;
        result.emails.push(customerNoticeOutbox);
      }
    }
    const ports: LifecycleResult["tasks"][number]["port"][] = ["CALENDAR", "OWNER_EMAIL"];
    if (["MARK_NO_SHOW", "NO_SHOW", "REVERSE_NO_SHOW"].includes(intent.action))
      ports.push("CUSTOMER_EMAIL");
    for (const port of ports)
      result.tasks.push({
        port,
        state:
          (port === "OWNER_EMAIL" && ownerOutbox) ||
          (port === "CUSTOMER_EMAIL" &&
            (customerNoticeOutbox || (intent.action !== "MARK_NO_SHOW" && result.emails[0])))
            ? "PLANNED"
            : "BLOCKED_UNVERIFIED",
        bookingId: booking._id,
        lifecycleVersion: booking.rescheduleHistory.length,
        eventVersion: booking.eventHistory.length,
        bookingStatus: booking.status,
        ...(booking.googleCalendarEventId
          ? { existingEventId: booking.googleCalendarEventId }
          : {}),
        ...(port === "OWNER_EMAIL" && ownerOutbox ? { outboxId: ownerOutbox } : {}),
        ...(port === "CUSTOMER_EMAIL" &&
        (customerNoticeOutbox || (intent.action !== "MARK_NO_SHOW" && result.emails[0]))
          ? { outboxId: customerNoticeOutbox ?? result.emails[0] }
          : {}),
        startAt: booking.schedule.startAt,
        endAt: booking.schedule.endAt,
      });
  }
  /** Reuses the complete committed-result verifier for Calendar membership, including paid
   * redemption evidence. It has no scheduling, payment or delivery side effects. */
  public static async verifyCalendarResult(id: Types.ObjectId, intent: LifecycleIntent) {
    await verifyPackageBatchActivation();
    return verifyCommittedLifecycleResult(id, intent);
  }
  async #read(id: Types.ObjectId, intent: LifecycleIntent) {
    return verifyCommittedLifecycleResult(id, intent);
  }
  async #resolve(id: Types.ObjectId, intent: LifecycleIntent) {
    for (let i = 0; i < 6; i++) {
      try {
        const result = await this.#read(id, intent);
        if (result) return result;
      } catch {
        /* unavailable/contradictory proof stays unresolved, never absence cleanup */
      }
    }
    throw new PackageBatchUnresolvedError();
  }
}

async function verifyCommittedLifecycleResult(id: Types.ObjectId, intent: LifecycleIntent) {
  const row = await PackageLifecycleOperationModel.findById(id).read("primary").maxTimeMS(2000);
  if (row?.phase !== "COMPLETE") return null;
  if (digest(row.intent) !== digest(intent)) throw batchConflict();
  const result = readLifecycleResult(row.result);
  const progress = await PackageProgressV2Model.findOne({
    _id: intent.packageProgressId,
    businessId: intent.businessId,
    customerUserId: intent.customerUserId,
    businessClientId: intent.businessClientId,
  })
    .read("primary")
    .maxTimeMS(2000);
  if (!progress) throw batchConflict();
  const plain = progress.toObject();
  for (const key of ["createdAt", "updatedAt", "__v"]) Reflect.deleteProperty(plain, key);
  packageProgressV2InputSchema.parse(plain);
  if (intent.action === "EXPIRE") {
    if (progress.creditAccountingVersion !== 2) throw batchConflict();
    if (result.status === "FOREVER") {
      if (progress.purchasedContract.validity.mode !== "FOREVER") throw batchConflict();
    } else if (
      !progress.expiryReconciledAt ||
      progress.items.some((item) => !item.expiryEvent || item.remainingSessions !== 0)
    )
      throw batchConflict();
  }
  let booking = null;
  const resultBookingId = result.bookingId;
  if (resultBookingId) {
    booking = await BookingModel.findOne({
      _id: resultBookingId,
      businessId: intent.businessId,
      "customer.customerUserId": intent.customerUserId,
      "customer.businessClientId": intent.businessClientId,
    })
      .read("primary")
      .maxTimeMS(2000);
    const line = booking?.serviceLines[0],
      attempt = progress.sessions.find((a) => a.bookingId.equals(resultBookingId));
    if (
      !booking ||
      !line ||
      !attempt ||
      !line.pricingInput.packageProgressId?.equals(progress._id) ||
      !attempt.packageItemId.equals(line.pricingInput.packageItemId ?? new Types.ObjectId()) ||
      !attempt.serviceId.equals(line.serviceId)
    )
      throw batchConflict();
    const expected =
      booking.status === "UPCOMING" || booking.status === "PENDING"
        ? "SCHEDULED"
        : booking.status === "COMPLETED"
          ? "COMPLETED"
          : ["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_BUSINESS", "NO_SHOW_CANCELLED"].includes(
                booking.status,
              )
            ? "CANCELLED"
            : "FORFEITED";
    if (attempt.status !== expected) throw batchConflict();
    if (result.reservationKey) {
      if (!result.staffMembershipId) throw batchConflict();
      const effect = await BookingSlotReservationClaimModel.findOne({
        idempotencyKey: result.reservationKey,
        businessId: intent.businessId,
        serviceId: line.serviceId,
        staffMembershipId: result.staffMembershipId,
        partySize: 1,
      })
        .read("primary")
        .maxTimeMS(2000);
      if (
        !effect?.effect ||
        !result.reservationId ||
        !effect.effect.actualReservationId.equals(result.reservationId) ||
        effect.originalIntent?.startAt.getTime() !==
          (result.startAt ?? intent.startAt)?.getTime() ||
        effect.originalIntent?.endAt.getTime() !== result.endAt?.getTime() ||
        effect.originalIntent?.capacityMax !== (line.schedulingSnapshot?.group?.capacityMax ?? 1) ||
        (effect.effect.state !== "APPLIED" && effect.effect.state !== "RELEASED") ||
        (intent.action === "CANCEL" && effect.effect.state !== "RELEASED")
      )
        throw batchConflict();
    }
  }
  if (intent.dues) {
    const q = lifecycleSessionQuoteSchema.parse(row.sessionQuote),
      a = lifecycleSessionAcceptanceSchema.parse(row.sessionAcceptance);
    if (
      !booking ||
      !result.bookingId ||
      !q.terms.bookingId.equals(result.bookingId) ||
      q.terms.intentHash !== digest(intent) ||
      q.termsHash !== digest(q.terms) ||
      q.disclosureHash !== digest(q.disclosure) ||
      !a.quoteId.equals(q.quoteId) ||
      !a.customerUserId.equals(intent.customerUserId) ||
      a.termsHash !== q.termsHash ||
      a.disclosureHash !== q.disclosureHash ||
      a.sessionFamilyId !== q.sessionFamilyId ||
      digest(booking.toObject().fulfilment) !== digest(q.terms.fulfilment) ||
      booking.financials.servicesSubtotalCents !== 0 ||
      booking.financials.addonsSubtotalCents !== q.terms.addonsCents ||
      booking.financials.travelFeeCents !== q.terms.travelCents ||
      booking.financials.totalCents !== q.terms.totalCents ||
      booking.financials.depositCents !==
        (q.terms.paymentMethod === "ONLINE" ? q.terms.totalCents : 0)
    )
      throw batchConflict();
    const item = progress.items.find((i) =>
      i.packageItemId.equals(intent.packageItemId ?? new Types.ObjectId()),
    );
    if (
      !item ||
      digest(
        plain.items.find((i) => i.packageItemId.equals(item.packageItemId))?.travelCities ?? [],
      ) !== q.terms.travelRightsHash
    )
      throw batchConflict();
  }
  if (result.money) {
    const attempt = await PaymentAttemptModel.findById(result.money.attemptId)
      .read("primary")
      .maxTimeMS(2000)
      .orFail();
    const authority = await inspectLifecyclePaymentAuthority(attempt);
    if (
      authority?.kind !== "COMPLETE" ||
      attempt.persistenceStatus !== "COMPLETED" ||
      !authority.row._id.equals(id)
    )
      throw batchConflict();
  }
  if (result.venue) {
    if (
      !intent.venuePayment ||
      !booking ||
      (booking.completionPayment?.amountCents ?? 0) < result.venue.cumulativeCents
    )
      throw batchConflict();
    if (result.venue.amountCents > 0) {
      if (
        !result.venue.ledgerId ||
        !(await BookingFinancialTransactionModel.exists({
          _id: result.venue.ledgerId,
          businessId: intent.businessId,
          bookingId: booking._id,
          customerUserId: intent.customerUserId,
          businessClientId: intent.businessClientId,
          type: "PAYMENT",
          direction: "DEBIT",
          status: "SUCCEEDED",
          amountCents: result.venue.amountCents,
          idempotencyKey: `package-venue:${id}`,
          "metadata.collectedAtVenue": true,
          "metadata.lifecycleOperationId": String(id),
        })
          .read("primary")
          .maxTimeMS(2000))
      )
        throw batchConflict();
    } else if (result.venue.ledgerId) throw batchConflict();
  }
  for (const email of result.emails)
    if (
      !(await EmailOutboxModel.exists({ _id: email, eventKey: `PACKAGE_LIFECYCLE:${intent.key}` })
        .read("primary")
        .maxTimeMS(2000))
    )
      throw batchConflict();
  for (const reminder of result.reminders) {
    if (!result.bookingId) throw batchConflict();
    if (
      !(await AppointmentReminderModel.exists({
        _id: reminder,
        bookingId: result.bookingId,
        businessId: intent.businessId,
        customerUserId: intent.customerUserId,
      })
        .read("primary")
        .maxTimeMS(2000))
    )
      throw batchConflict();
  }
  return { result, booking, progress };
}
