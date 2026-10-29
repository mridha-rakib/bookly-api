import mongoose, { Types } from "mongoose";
import { z } from "zod";
import { logger } from "../../config/logger.js";
import { BookingFinancialTransactionModel } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import {
  type RefundIncidentCategory,
  type RefundOperationDocument,
  RefundOperationModel,
} from "./refund-operation.model.js";

export const REFUND_INCIDENT_GUIDANCE =
  "Inspect this RefundOperation, its Business/Booking, source PaymentAttempt, " +
  "source/refund ledger and final-notification marker together. Preserve conflicting evidence. " +
  "Do not replay a refund or change settlement/notification markers to silence this incident. " +
  "Use the existing authorized reconciliation path only after exact financial evidence agrees.";

export type RefundIncidentAlertPolicy = {
  recipients: string[];
  minObservations: number;
  minAgeMs: number;
};
const policySchema = z.object({
  recipients: z.array(z.email()).min(1),
  minObservations: z.coerce.number().int().positive().safe(),
  minAgeMs: z.coerce.number().int().nonnegative().safe(),
});
/** No default destination or escalation threshold. Partial/invalid configuration fails startup. */
export function parseRefundIncidentAlertPolicy(
  environment: Record<string, string | undefined>,
): RefundIncidentAlertPolicy | undefined {
  const recipients = environment["BOOKLY_REFUND_INCIDENT_ALERT_RECIPIENTS"];
  const minObservations = environment["BOOKLY_REFUND_INCIDENT_ALERT_MIN_OBSERVATIONS"];
  const minAgeMs = environment["BOOKLY_REFUND_INCIDENT_ALERT_MIN_AGE_MS"];
  if (recipients === undefined && minObservations === undefined && minAgeMs === undefined)
    return undefined;
  if (!recipients?.trim() || !minObservations?.trim() || !minAgeMs?.trim())
    throw new Error("Refund incident alert configuration must specify all three settings");
  const result = policySchema.safeParse({
    recipients: [...new Set(recipients.split(",").map((value) => value.trim().toLowerCase()))],
    minObservations,
    minAgeMs,
  });
  if (!result.success) throw new Error("Refund incident alert configuration is invalid");
  return result.data;
}

/** One incident per exact RefundOperation; no provider, settlement or accounting writes. */
export class RefundRecoveryIncidentService {
  public constructor(
    private readonly policy?: RefundIncidentAlertPolicy,
    private readonly outbox: Pick<EmailOutboxService, "enqueue"> = new EmailOutboxService(),
  ) {}

  public async observe(
    operationId: Types.ObjectId,
    category: RefundIncidentCategory,
  ): Promise<void> {
    const now = new Date();
    // Single-document CAS deduplication across retries and workers; no dependence on a new unique index.
    for (let attempt = 0; attempt < 3; attempt++) {
      const evidence = await RefundOperationModel.findById(operationId)
        .select(
          "finalNotificationRecordedAt lastReconciledAt finalNotificationProtocolVersion reason packageProgressId providerStatus",
        )
        .lean()
        .exec();
      if (!evidence) throw new Error("Refund incident operation not found");
      // A concurrent canonical notification transaction may have finished after a NOT_READY
      // result was read. Do not turn that stale notification observation into a new incident.
      if (
        category !== "REFUND_RECOVERY_FAILED" &&
        evidence.finalNotificationProtocolVersion === 1 &&
        evidence.reason === "BUSINESS_CANCELLATION" &&
        !evidence.packageProgressId &&
        evidence.finalNotificationRecordedAt &&
        ["SUCCEEDED", "FAILED"].includes(evidence.providerStatus)
      )
        return;
      const observed = {
        notificationMarkerAtObservation: evidence.finalNotificationRecordedAt ?? null,
        reconciliationAtObservation: evidence.lastReconciledAt ?? null,
      };
      const repeated = await RefundOperationModel.updateOne(
        { _id: operationId, "recoveryIncident.state": "OPEN" },
        {
          $set: {
            "recoveryIncident.lastObservedAt": now,
            "recoveryIncident.category": category,
            "recoveryIncident.notificationMarkerAtObservation":
              observed.notificationMarkerAtObservation,
            "recoveryIncident.reconciliationAtObservation": observed.reconciliationAtObservation,
          },
          $inc: { "recoveryIncident.observations": 1 },
        },
        { timestamps: false, writeConcern: { w: "majority", j: true } },
      ).exec();
      if (repeated.matchedCount) return;
      const opened = await RefundOperationModel.findOneAndUpdate(
        { _id: operationId, "recoveryIncident.state": { $ne: "OPEN" } },
        {
          $set: {
            recoveryIncident: {
              episodeId: new Types.ObjectId(),
              state: "OPEN",
              category,
              openedAt: now,
              lastObservedAt: now,
              lastCheckedAt: new Date(0),
              observations: 1,
              ...observed,
            },
          },
        },
        { returnDocument: "after", timestamps: false, writeConcern: { w: "majority", j: true } },
      )
        .lean<RefundOperationDocument>()
        .exec();
      if (opened) {
        logger.warn(
          {
            event: "REFUND_RECOVERY_INCIDENT_OPENED",
            refundOperationId: String(opened._id),
            businessId: opened.businessId ? String(opened.businessId) : undefined,
            episodeId: String(opened.recoveryIncident!.episodeId),
            category,
          },
          "Refund recovery requires investigation",
        );
        return;
      }
    }
    throw new Error("Refund incident observation could not be recorded");
  }

  /** A separate fair sweep sees open incidents even after normal due/notification queries retire them. */
  public async poll(limit: number): Promise<void> {
    const rows = await RefundOperationModel.find({ "recoveryIncident.state": "OPEN" })
      .select("_id")
      .sort({ "recoveryIncident.lastCheckedAt": 1, _id: 1 })
      .limit(Math.max(1, Math.min(limit, 100)))
      .lean()
      .exec();
    let failed = false;
    for (const row of rows) {
      try {
        await this.check(row._id);
      } catch {
        failed = true;
        // No provider exception, amount, request payload, email or access credential in logs.
        logger.error(
          { event: "REFUND_RECOVERY_INCIDENT_CHECK_FAILED", refundOperationId: String(row._id) },
          "Refund incident monitoring failed; incident remains durable",
        );
      } finally {
        await RefundOperationModel.updateOne(
          { _id: row._id, "recoveryIncident.state": "OPEN" },
          { $set: { "recoveryIncident.lastCheckedAt": new Date() } },
          { timestamps: false },
        ).exec();
      }
    }
    if (failed) throw new Error("Refund incident monitoring incomplete");
  }

  private async check(operationId: Types.ObjectId): Promise<void> {
    const session = await mongoose.startSession();
    let transition: "RESOLVED" | "ALERT_QUEUED" | undefined;
    let correlation: { businessId?: string; episodeId: string } | undefined;
    try {
      await session.withTransaction(
        async () => {
          transition = undefined;
          const operation = await RefundOperationModel.findById(operationId)
            .session(session)
            .exec();
          const incident = operation?.recoveryIncident;
          if (!operation || !incident || incident.state !== "OPEN") return;
          correlation = {
            episodeId: String(incident.episodeId),
            ...(operation.businessId ? { businessId: String(operation.businessId) } : {}),
          };
          // An opted-in ordinary cancellation closes ONLY after the existing exact-evidence
          // notification transaction has committed. That can truthfully represent FAILED too;
          // resolving an evidence incident never asserts refund success.
          const optedIn =
            operation.finalNotificationProtocolVersion === 1 &&
            operation.reason === "BUSINESS_CANCELLATION" &&
            !operation.packageProgressId;
          let resolved =
            optedIn &&
            ["SUCCEEDED", "FAILED"].includes(operation.providerStatus) &&
            Boolean(
              operation.finalNotificationRecordedAt &&
                operation.finalNotificationRecordedAt.getTime() !==
                  incident.notificationMarkerAtObservation?.getTime() &&
                operation.finalNotificationRecordedAt.getTime() >=
                  incident.lastObservedAt.getTime(),
            );
          // Package authority remains separate; matching monetary rows alone cannot clear a
          // Package compensation/void authority incident.
          if (
            !optedIn &&
            !operation.packageProgressId &&
            operation.providerStatus === "SUCCEEDED" &&
            operation.providerRefundId &&
            operation.businessId &&
            operation.bookingId &&
            operation.businessClientId &&
            operation.succeededLedgerTransactionId &&
            !operation.reconciliationNeededAt &&
            operation.lastReconciledAt &&
            operation.lastReconciledAt.getTime() >= incident.lastObservedAt.getTime() &&
            operation.lastReconciledAt.getTime() !== incident.reconciliationAtObservation?.getTime()
          ) {
            resolved = Boolean(
              await BookingFinancialTransactionModel.exists({
                _id: operation.succeededLedgerTransactionId,
                businessId: operation.businessId,
                bookingId: operation.bookingId,
                businessClientId: operation.businessClientId,
                ...(operation.customerUserId
                  ? { customerUserId: operation.customerUserId }
                  : { customerUserId: { $exists: false } }),
                type: "REFUND",
                direction: "CREDIT",
                status: "SUCCEEDED",
                currency: operation.currency,
                amountCents: operation.expectedRefundAmountCents,
                providerReference: operation.providerRefundId,
                idempotencyKey: `refund-operation:${String(operation._id)}:ledger`,
                ...(operation.sourceFinancialTransactionId
                  ? {
                      "metadata.sourceTransactionId": String(
                        operation.sourceFinancialTransactionId,
                      ),
                    }
                  : {}),
              }).session(session),
            );
          }
          const filter = {
            _id: operation._id,
            "recoveryIncident.state": "OPEN",
            "recoveryIncident.episodeId": incident.episodeId,
          };
          if (resolved) {
            await RefundOperationModel.updateOne(
              filter,
              {
                $set: {
                  "recoveryIncident.state": "RESOLVED",
                  "recoveryIncident.resolvedAt": new Date(),
                },
              },
              { session, timestamps: false },
            ).exec();
            transition = "RESOLVED";
            return;
          }
          const policy = this.policy;
          if (
            !policy ||
            incident.alertedAt ||
            incident.observations < policy.minObservations ||
            Date.now() - incident.openedAt.getTime() < policy.minAgeMs
          )
            return;
          // Lock the incident BEFORE the deduped enqueue, so competing monitors conflict on this
          // document and retry the transaction rather than racing the outbox's unique insert.
          const claimed = await RefundOperationModel.updateOne(
            { ...filter, "recoveryIncident.alertedAt": { $exists: false } },
            { $set: { "recoveryIncident.alertedAt": new Date() } },
            { session, timestamps: false },
          ).exec();
          if (claimed.modifiedCount !== 1) return;
          for (const recipient of policy.recipients) {
            await this.outbox.enqueue(
              {
                eventKey: `REFUND_INCIDENT:${String(operation._id)}:${String(incident.episodeId)}`,
                templateKey: "FINANCE_SUPPORT_ALERT",
                recipient,
                payload: {
                  kind: "REFUND_RECOVERY_CONFLICT",
                  providerReference: `RefundOperation ${String(operation._id)}`,
                  ...(operation.businessId ? { businessId: String(operation.businessId) } : {}),
                  ...(operation.bookingId ? { bookingId: String(operation.bookingId) } : {}),
                  detail: `Observed ${incident.category}; check current incident state as it may have since resolved. ${REFUND_INCIDENT_GUIDANCE}`,
                },
              },
              session,
            );
          }
          transition = "ALERT_QUEUED";
        },
        { readConcern: { level: "snapshot" }, writeConcern: { w: "majority", j: true } },
      );
      if (transition)
        logger.info(
          {
            event: `REFUND_RECOVERY_INCIDENT_${transition}`,
            refundOperationId: String(operationId),
            ...correlation,
          },
          "Refund incident monitoring transition",
        );
    } finally {
      await session.endSession();
    }
  }
}
