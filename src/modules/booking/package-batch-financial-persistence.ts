import mongoose, { Types } from "mongoose";
import { AppointmentReminderRepository } from "../appointment-reminder/appointment-reminder.repository.js";
import { BookingFinancialTransactionRepository } from "../booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import { BusinessModel } from "../business/business.model.js";
import { BusinessClientModel } from "../client/client.model.js";
import type { FinancialRelationshipService } from "../client/financial-relationship.service.js";
import { buildBookingEmailData } from "../email/templates/booking/booking-email-data.js";
import { EmailOutboxRepository } from "../email-outbox/email-outbox.repository.js";
import type { PaymentService } from "../payment/payment.service.js";
import { PaymentAttemptRepository } from "../payment/payment-attempt.repository.js";
import {
  type PaymentBatchBinding,
  paymentBatchMetadata,
} from "../payment/payment-batch-binding.js";
import { buildPaymentIntentMetadata } from "../payment/payment-intent-metadata.js";
import { UserModel } from "../user/user.model.js";
import { BookingModel } from "./booking.model.js";
import {
  appendBatchCompletion,
  claimInternalPackageBatch,
  loadOwnedPackageBatch,
  markBatchCompensatedFailure,
  type PackageBatchScope,
  prepareInternalPackageBatch,
  releaseKnownAbortedPackageBatch,
  retainBatchFinance,
} from "./booking-creation-claim.model.js";
import { verifyPackageBatchActivation } from "./package-batch-authority.js";
import { readOwnedPackageBatchCompletion } from "./package-batch-completion.js";
import type { BatchCompletion, BatchDeliveryTask } from "./package-batch-completion-contract.js";
import {
  batchConflict,
  canonicalPackageBatch,
  PackageBatchUnresolvedError,
} from "./package-batch-contract.js";
import type { PackageBatchPersistence } from "./package-batch-persistence.js";
import { hashCanonicalPackageCheckoutContent as digest } from "./package-checkout-binding.js";
import { verifyPackagePurchaseConsentCertification } from "./package-purchase-authority.js";

/** Unregistered, activation-denied F2 parent. No provider is invoked in a transaction.
 * Current supported dependency subset remains explicit; rejected offers lose no accepted terms. */
export class PackageBatchFinancialPersistence {
  public constructor(
    private readonly core: PackageBatchPersistence,
    private readonly relationships: FinancialRelationshipService,
    private readonly payments: PaymentService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async complete(scope: PackageBatchScope) {
    await verifyPackageBatchActivation();
    const replay = await readOwnedPackageBatchCompletion(scope);
    if (replay) return replay;
    // Required for direct F2 callers and recovery too: rollout authority alone cannot
    // authorize a charge, FIRST admission or fresh entitlement from uncertified consent.
    const certified = await verifyPackagePurchaseConsentCertification(scope);
    const row = await loadOwnedPackageBatch(scope);
    if (row.packageBatchControl?.phase === "FAILED_FINAL") throw batchConflict();
    if (row.packageBatchControl?.phase === "PERSISTING" || row.packageBatchMaterialization) {
      const attempt = await new PaymentAttemptRepository().findByLogicalKey(scope.idempotencyKey);
      if (
        !row.packageBatchMaterialization &&
        attempt?.compensationStatus === "REFUNDED" &&
        (await markBatchCompensatedFailure(scope, attempt._id))
      )
        throw batchConflict();
      return this.resolve(scope);
    }
    const { quote: q } = canonicalPackageBatch(row.toObject());
    if (
      q.appointments.some((a) => a.location.mode === "TRAVEL_TO_CUSTOMER") &&
      q.items.some((i) => !i.travelEntitlement)
    )
      throw batchConflict();
    const now = this.clock();
    if (
      !Number.isFinite(now.getTime()) ||
      now < q.issuedAt ||
      now >= q.expiresAt ||
      q.appointments.some((a) => a.startAt <= now)
    )
      throw batchConflict();
    const p = await prepareInternalPackageBatch(scope, now);
    const client = await BusinessClientModel.findOne({
      _id: p.businessClientId,
      businessId: p.businessId,
      linkedUserId: p.customerUserId,
    }).orFail();
    const classification = await this.relationships.resolveForFinalize({
      client,
      identity: {
        idempotencyKey: p.idempotencyKey,
        bookingId: p.originBookingId,
        customerUserId: p.customerUserId,
        productKind: "PACKAGE_PURCHASE",
      },
      existingContract: row.packageBatchFinance?.contract,
    });
    const originAllocation = q.financials.appointments.find((a) =>
      a.bookingId.equals(p.originBookingId),
    );
    if (!originAllocation) throw batchConflict();
    const finance = await retainBatchFinance(scope, {
      version: 1,
      preparationHash: digest(p),
      contract: {
        version: 2,
        productKind: "PACKAGE_PURCHASE",
        classification,
        idempotencyKey: p.idempotencyKey,
        bookingId: p.originBookingId,
        customerUserId: p.customerUserId,
        businessId: p.businessId,
        businessClientId: p.businessClientId,
        currency: "EUR",
        eligibleBasisCents: q.financials.bundlePriceCents,
        packageBundlePriceCents: q.financials.bundlePriceCents,
        requiredUpfrontCents: q.financials.requiredUpfrontCents,
        promoDiscountCents: 0,
        onlineChargeCents: q.financials.requiredUpfrontCents,
        travelFeeCents: originAllocation.travelCents,
        bookingTotalCents:
          originAllocation.includedBaseCents +
          originAllocation.addonsCents +
          originAllocation.travelCents,
        upfrontLedgerType: classification === "FIRST" ? "PLATFORM_FEE" : "DEPOSIT",
      },
    }).catch(async (error: unknown) => {
      await this.relationships
        .releaseAfterPreMoneyFailure(p.businessClientId, p.idempotencyKey)
        .catch(() => undefined);
      throw error;
    });
    const c = finance.contract;
    const attempts = new PaymentAttemptRepository();
    let attemptId: string | undefined, paymentToken: string | undefined;
    let providerId: string | undefined;
    // The exact claim/attempt binding is frozen before provider dispatch by PaymentService.
    if (c.onlineChargeCents > 0) {
      const binding: PaymentBatchBinding = {
        version: 1,
        claimId: String(p.claimId),
        batchId: String(p.batchId),
        quoteId: String(p.quoteId),
        termsHash: p.termsHash,
        acceptanceId: String(p.acceptanceId),
        packageProgressId: String(p.packageProgressId),
        originBookingId: String(p.originBookingId),
        businessId: String(p.businessId),
        customerUserId: String(p.customerUserId),
        businessClientId: String(p.businessClientId),
      };
      const charge = await this.payments.chargeBookingDeposit({
        userId: p.customerUserId,
        amountCents: c.onlineChargeCents,
        idempotencyKey: p.idempotencyKey,
        packageBatchBinding: binding,
        financialContract: {
          version: 2,
          classification,
          productKind: "PACKAGE_PURCHASE",
          businessClientId: String(p.businessClientId),
        },
        metadata: {
          ...buildPaymentIntentMetadata({
            bookingId: String(p.originBookingId),
            businessId: String(p.businessId),
            businessClientId: String(p.businessClientId),
            purpose: "PACKAGE_PURCHASE",
            preTaxChargeCents: c.onlineChargeCents,
            taxCents: 0,
            chargedAmountCents: c.onlineChargeCents,
            taxMode: "PRE_ACTIVATION",
            financialContract: { version: 2, classification, productKind: "PACKAGE_PURCHASE" },
          }),
          ...paymentBatchMetadata(binding),
        },
        beforeProviderDispatch: async (attempt) => {
          if (classification === "FIRST")
            await this.relationships.bindPaymentAttempt(
              p.businessClientId,
              p.idempotencyKey,
              attempt._id,
            );
        },
      });
      if (charge.status !== "succeeded" || !charge.paymentAttemptId)
        throw new PackageBatchUnresolvedError();
      attemptId = charge.paymentAttemptId;
      providerId = charge.paymentIntentId;
    }
    // Provider preparation can require action or reconciliation. Only pin persistence once
    // payment succeeded; retries recover the same durable PaymentAttempt/provider key.
    const token = await claimInternalPackageBatch(scope, p);
    if (!token) return this.resolve(scope);
    if (attemptId) {
      const claimed = await attempts.claimPersistence(attemptId);
      if (!claimed) return this.resolve(scope);
      paymentToken = claimed;
    }
    const session = await mongoose.startSession();
    let returned = false;
    try {
      await session.withTransaction(
        async () => {
          returned = false;
          if (certified) {
            const b = certified.binding;
            const pinned = await BusinessClientModel.findOneAndUpdate(
              {
                _id: b.businessClientId,
                businessId: b.businessId,
                linkedUserId: b.customerUserId,
                linkState: "LINKED",
                archivedAt: { $exists: false },
                ...(b.linkGeneration === 0
                  ? { $or: [{ linkGeneration: 0 }, { linkGeneration: { $exists: false } }] }
                  : { linkGeneration: b.linkGeneration }),
              },
              { $inc: { consentFence: 1 } },
              { session, returnDocument: "after" },
            );
            if (!pinned) throw batchConflict();
          }
          await this.core.materializeInSession(scope, token, session);
          const current = await loadOwnedPackageBatch(scope, session);
          if (digest(current.packageBatchFinance) !== digest(finance)) throw batchConflict();
          const relationship = await BusinessClientModel.findById(p.businessClientId)
            .session(session)
            .orFail();
          if (
            classification === "RETURNING" &&
            relationship.financialRelationship?.state !== "CONSUMED"
          )
            throw batchConflict();
          const origin = await BookingModel.findById(p.originBookingId).session(session).orFail();
          origin.financialContract = c;
          origin.financials.depositCents = c.requiredUpfrontCents;
          origin.financials.platformFeeCents =
            classification === "FIRST" ? c.requiredUpfrontCents : 0;
          origin.financials.balanceDueCents = origin.financials.totalCents - c.requiredUpfrontCents;
          await origin.save({ session });
          let ledgerId: Types.ObjectId | undefined;
          if (attemptId && paymentToken && providerId) {
            const ledger = await new BookingFinancialTransactionService(
              new BookingFinancialTransactionRepository(),
            ).record(
              {
                businessId: p.businessId,
                bookingId: p.originBookingId,
                businessClientId: p.businessClientId,
                customerUserId: p.customerUserId,
                type: c.upfrontLedgerType,
                direction: "DEBIT",
                amountCents: c.onlineChargeCents,
                currency: "EUR",
                status: "SUCCEEDED",
                providerReference: providerId,
                idempotencyKey: `${p.idempotencyKey}:deposit`,
              },
              session,
            );
            ledgerId = ledger._id;
            if (
              !(await attempts.markCompleted(
                attemptId,
                {
                  bookingId: p.originBookingId,
                  packageProgressId: p.packageProgressId,
                  succeededTransactionId: ledgerId,
                },
                paymentToken,
                session,
              ))
            )
              throw batchConflict();
          }
          if (
            classification === "FIRST" &&
            !(await this.relationships.consumeFirst(
              p.businessClientId,
              {
                idempotencyKey: p.idempotencyKey,
                bookingId: p.originBookingId,
                productKind: "PACKAGE_PURCHASE",
                paymentAttemptId: attemptId,
                financialTransactionId: ledgerId,
              },
              session,
            ))
          )
            throw batchConflict();
          const business = await BusinessModel.findById(p.businessId).session(session).orFail();
          const owner = await UserModel.findById(business.ownerUserId).session(session);
          const emails: BatchCompletion["emails"] = [],
            reminders: BatchCompletion["reminders"] = [];
          const tasks: BatchDeliveryTask[] = [];
          for (const m of p.members) {
            const booking = await BookingModel.findById(m.bookingId).session(session).orFail();
            const plans = [
              {
                recipient: booking.customer.contact.normalizedEmail,
                templateKey: "BOOKING_CUSTOMER_CONFIRMED" as const,
                includeCustomerBookingLink: true,
              },
              ...(owner
                ? [
                    {
                      recipient: owner.normalizedEmail,
                      templateKey: "BOOKING_OWNER_NEW_BOOKING" as const,
                      includeCustomerBookingLink: false,
                    },
                  ]
                : []),
            ];
            for (const plan of plans) {
              const payload = {
                ...buildBookingEmailData(booking.toObject(), {
                  businessName: business.name,
                  includeCustomerBookingLink: plan.includeCustomerBookingLink,
                }),
              };
              const { record } = await new EmailOutboxRepository().enqueue(
                {
                  eventKey: `BOOKING_CREATED:${m.bookingId}`,
                  recipient: plan.recipient,
                  templateKey: plan.templateKey,
                  payload,
                },
                session,
              );
              if (digest(record.payload) !== digest(payload)) throw batchConflict();
              emails.push({
                id: record._id,
                dedupeKey: record.dedupeKey,
                payloadHash: digest(payload),
              });
            }
            const { record } = await new AppointmentReminderRepository().schedule(
              {
                kind: "REMINDER_24H",
                bookingId: m.bookingId,
                businessId: p.businessId,
                customerUserId: p.customerUserId,
                scheduleStartAt: m.startAt,
                now: this.clock(),
              },
              session,
            );
            reminders.push({ id: record._id, dedupeKey: record.dedupeKey });
            const alert = booking.sessionEndReminderSnapshot;
            if (alert?.enabled && alert.minutesBeforeSessionEnds !== undefined) {
              const end = await new AppointmentReminderRepository().schedule(
                {
                  kind: "SESSION_END_REMINDER",
                  bookingId: m.bookingId,
                  businessId: p.businessId,
                  customerUserId: p.customerUserId,
                  scheduleStartAt: m.endAt,
                  offsetMinutes: alert.minutesBeforeSessionEnds,
                  now: this.clock(),
                },
                session,
              );
              reminders.push({ id: end.record._id, dedupeKey: end.record.dedupeKey });
            }
            for (const port of ["CALENDAR", ...(!owner ? ["OWNER_EMAIL" as const] : [])] as const)
              tasks.push({
                lifecycleVersion: 0,
                key: `${p.batchId}:${m.bookingId}:CREATED:v0:${port}`,
                bookingId: m.bookingId,
                startAt: m.startAt,
                endAt: m.endAt,
                port,
                state: "BLOCKED_UNVERIFIED",
                attempts: 0,
                nextDue: this.clock(),
              });
          }
          await appendBatchCompletion(
            scope,
            token,
            {
              ...(certified
                ? {
                    version: 2 as const,
                    state: "GENUINE_COMPLETE_BATCH" as const,
                    activation: "CERTIFIED_ORIGINAL_CONSENT" as const,
                    consentCertificateId: certified.certificateId,
                    consentCertificateHash: certified.certificateHash,
                  }
                : // Only isolated tests mock certification to return undefined. Shipped
                  // certification never does; historical v1 data is never promoted.
                  {
                    version: 1 as const,
                    state: "PREPARATION_ONLY_COMPLETE_BATCH" as const,
                    activation: "SYNTHETIC_AUTHORITY_NOT_PRODUCTION_CONSENT" as const,
                  }),
              preparationHash: digest(p),
              financeHash: digest(finance),
              ...(attemptId ? { paymentAttemptId: new Types.ObjectId(attemptId) } : {}),
              ...(ledgerId ? { ledgerId } : {}),
              emails,
              reminders,
              tasks: tasks.map(({ key, bookingId, port, startAt, endAt, lifecycleVersion }) => ({
                lifecycleVersion,
                key,
                bookingId,
                port,
                startAt,
                endAt,
              })),
            },
            tasks,
            session,
          );
          returned = true;
        },
        { readConcern: { level: "snapshot" }, writeConcern: { w: "majority", j: true } },
      );
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
      if (unknown) return this.resolve(scope);
      if (attemptId && paymentToken && providerId) {
        if (
          (await attempts.markCompensationRequired(
            attemptId,
            "Definite batch transaction abort",
            paymentToken,
          )) &&
          (await attempts.claimCompensation(attemptId))
        ) {
          const refund = await this.payments.refund({
            paymentIntentId: providerId,
            amountCents: c.onlineChargeCents,
            currency: "EUR",
            idempotencyKey: `refund:${providerId}:compensation`,
            reason: "requested_by_customer",
            domainReason: "BOOKING_PERSISTENCE_COMPENSATION",
            sourcePaymentAttemptId: attemptId,
            bookingId: p.originBookingId,
            packageProgressId: p.packageProgressId,
            businessId: p.businessId,
            customerUserId: p.customerUserId,
            businessClientId: p.businessClientId,
          });
          await this.relationships.reconcileQuietly(p.businessClientId);
          if (refund.status === "succeeded")
            await markBatchCompensatedFailure(scope, attemptId).catch(() => undefined);
        }
      } else {
        await releaseKnownAbortedPackageBatch(scope, token);
        await this.relationships
          .releaseAfterPreMoneyFailure(p.businessClientId, p.idempotencyKey)
          .catch(() => undefined);
      }
      throw error;
    } finally {
      await session.endSession().catch(() => undefined);
    }
    return this.resolve(scope);
  }

  private async resolve(scope: PackageBatchScope) {
    for (let n = 0; n < 6; n += 1) {
      try {
        const winner = await readOwnedPackageBatchCompletion(scope);
        if (winner) return winner;
      } catch {
        /* Incomplete/unavailable proof never authorizes compensation. */
      }
    }
    throw new PackageBatchUnresolvedError();
  }
}
