import { isDeepStrictEqual } from "node:util";
import { Types } from "mongoose";
import { AppointmentReminderModel } from "../appointment-reminder/appointment-reminder.model.js";
import { BookingFinancialTransactionModel } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import { BusinessModel } from "../business/business.model.js";
import { EmailError } from "../email/email.errors.js";
import {
  formatDateInTimezone,
  formatTimeInTimezone,
} from "../email/templates/components/email-format.js";
import type { EmailOutboxDocument } from "../email-outbox/email-outbox.model.js";
import { toOnlinePayment } from "../notification/booking-created.notifier.js";
import { PackageProgressV2Model } from "../package-progress/package-progress-v2.model.js";
import { readPackagePurchaseCompletion } from "../package-progress/package-view.service.js";
import { PaymentAttemptModel } from "../payment/payment-attempt.model.js";
import type { RefundOperationDocument } from "../payment/refund-operation.model.js";
import { RefundOperationModel } from "../payment/refund-operation.model.js";
import { SmsError } from "../sms/sms.errors.js";
import type { SmsOutboxDocument } from "../sms-outbox/sms-outbox.model.js";
import { StaffMembershipModel } from "../staff/staff.model.js";
import { UserModel } from "../user/user.model.js";
import { type BookingDocument, BookingModel } from "./booking.model.js";
import { PackageLifecycleService } from "./package-lifecycle.service.js";
import {
  lifecycleIntentSchema,
  PackageLifecycleOperationModel,
} from "./package-lifecycle-operation.js";

/** Genuine purchase is required even if a Package Booking/reminder row physically exists. */
export async function bookingDeliveryPurchaseVerified(booking: BookingDocument): Promise<boolean> {
  const firstClass = booking.serviceLines.filter(
    (line) => line.pricingInput?.packageItemId || line.packageContext,
  );
  for (const line of firstClass) {
    const id = line.pricingInput.packageProgressId;
    if (!id) return false;
    const progress = await PackageProgressV2Model.findOne({
      _id: id,
      businessId: booking.businessId,
      customerUserId: booking.customer.customerUserId,
      businessClientId: booking.customer.businessClientId,
    })
      .read("primary")
      .maxTimeMS(2000);
    if (!progress || (await readPackagePurchaseCompletion(progress)) !== "VERIFIED") return false;
  }
  return true;
}

const confirmations = new Set([
  "BOOKING_CUSTOMER_CONFIRMED",
  "BOOKING_OWNER_NEW_BOOKING",
  "BOOKING_FOR_CLIENT_CONFIRMED",
  "BOOKING_STAFF_CREATED_NOTIFICATION",
]);
const reschedules = new Set(["BOOKING_RESCHEDULED_CUSTOMER", "STAFF_BOOKING_SCHEDULE_CHANGED"]);
const terminalNotices = new Set([
  "BOOKING_CANCELLED_CUSTOMER",
  "BOOKING_CANCELLED_OWNER",
  "STAFF_BOOKING_CANCELLED",
  "BOOKING_COMPLETED",
  "NO_SHOW_CHARGED",
  "NO_SHOW_WAIVED",
  "NO_SHOW_CANCELLED",
]);

/** Delivery-time safety, not a new queue or admission authority. Returning false retires
 * the claimed row with an explicit category. Storage outage retries without a provider call.
 * A lifecycle change after the final check can still race an already-issued external send. */
export class BookingEmailDeliveryEligibility {
  async check(record: EmailOutboxDocument, now: Date): Promise<boolean> {
    try {
      return await this.inspect(record, now);
    } catch (error) {
      throw new EmailError("PROVIDER_TRANSIENT", {
        safeProviderMessage: "Booking delivery eligibility unavailable",
        cause: error,
      });
    }
  }
  private async inspect(record: EmailOutboxDocument, now: Date): Promise<boolean> {
    const reminder = ["APPOINTMENT_REMINDER_24H", "SESSION_END_REMINDER"].includes(
      record.templateKey,
    );
    const activeNotice =
      confirmations.has(record.templateKey) || reschedules.has(record.templateKey);
    // Ordinary terminal notices retain their existing historical meaning. PACKAGE_LIFECYCLE
    // rows additionally need the actual committed lifecycle/purchase proof below.
    if (
      !reminder &&
      !activeNotice &&
      !terminalNotices.has(record.templateKey) &&
      !record.eventKey.startsWith("PACKAGE_LIFECYCLE:")
    )
      return true;
    let bookingId: Types.ObjectId | undefined;
    let refundEvidence: RefundOperationDocument | undefined;
    if (reminder) {
      const row = await AppointmentReminderModel.findOne({ dedupeKey: record.eventKey })
        .read("primary")
        .maxTimeMS(2000);
      if (!row || ["CANCELLED", "SKIPPED"].includes(row.status)) return false;
      if (row.emailDecision === "PENDING")
        throw Error("Reminder enqueue decision not yet committed");
      if (
        row.emailDecision !== "ENQUEUED" ||
        row.emailOutboxDedupeKey !== record.dedupeKey ||
        row.emailRecipient !== record.recipient
      )
        return false;
      const booking = await BookingModel.findOne({
        _id: row.bookingId,
        businessId: row.businessId,
        "customer.customerUserId": row.customerUserId,
      })
        .read("primary")
        .maxTimeMS(2000);
      if (!booking || booking.status !== "UPCOMING") return false;
      const anchor =
        row.kind === "SESSION_END_REMINDER" ? booking.schedule.endAt : booking.schedule.startAt;
      return (
        anchor.getTime() === row.scheduleStartAt.getTime() &&
        anchor > now &&
        (await bookingDeliveryPurchaseVerified(booking))
      );
    }
    if (record.eventKey.startsWith("BUSINESS_REFUND:")) {
      if (
        record.templateKey !== "BOOKING_CANCELLED_CUSTOMER" &&
        record.templateKey !== "BOOKING_CANCELLED_OWNER"
      )
        return false;
      const match = /^BUSINESS_REFUND:([a-f\d]{24}):([a-f\d]{24}):(SUCCEEDED|FAILED)$/.exec(
        record.eventKey,
      );
      if (!match?.[1] || !match[2] || !match[3]) return false;
      bookingId = new Types.ObjectId(match[1]);
      const refund = await RefundOperationModel.findOne({
        _id: new Types.ObjectId(match[2]),
        bookingId,
        providerStatus: match[3],
      })
        .read("primary")
        .maxTimeMS(2000);
      const outcome = record.payload.financialOutcome as { settlementStatus?: string } | undefined;
      if (
        !refund ||
        refund.reason !== "BUSINESS_CANCELLATION" ||
        refund.packageProgressId ||
        refund.logicalIdempotencyKey !== `business-cancel-refund:${String(bookingId)}` ||
        !refund.providerRefundId ||
        refund.finalNotificationProtocolVersion !== 1 ||
        !refund.finalNotificationRecordedAt ||
        outcome?.settlementStatus !== match[3]
      )
        return false;
      refundEvidence = refund;
      if (match[3] === "SUCCEEDED") {
        if (!refund.providerRefundId || !refund.succeededLedgerTransactionId) return false;
        const ledger = await BookingFinancialTransactionModel.findOne({
          _id: refund.succeededLedgerTransactionId,
          bookingId,
          businessId: refund.businessId,
          businessClientId: refund.businessClientId,
          customerUserId: refund.customerUserId,
          type: "REFUND",
          direction: "CREDIT",
          status: "SUCCEEDED",
          amountCents: refund.expectedRefundAmountCents,
          currency: refund.currency,
          providerReference: refund.providerRefundId,
          idempotencyKey: `refund-operation:${String(refund._id)}:ledger`,
          "metadata.sourceTransactionId": String(refund.sourceFinancialTransactionId),
        })
          .read("primary")
          .maxTimeMS(2000);
        if (!ledger) return false;
      }
    } else if (record.eventKey.startsWith("PACKAGE_LIFECYCLE:")) {
      const op = await PackageLifecycleOperationModel.findOne({
        "intent.key": record.eventKey.slice("PACKAGE_LIFECYCLE:".length),
        phase: "COMPLETE",
        "result.emails": record._id,
      })
        .read("primary")
        .maxTimeMS(2000);
      if (!op) return false;
      const intent = lifecycleIntentSchema.parse(op.intent);
      const result = await PackageLifecycleService.verifyCalendarResult(op._id, intent);
      if (!result || !result.result.emails.some((id) => id.equals(record._id))) return false;
      if ((await readPackagePurchaseCompletion(result.progress)) !== "VERIFIED") return false;
      bookingId = result.booking?._id;
      if (!bookingId) return !activeNotice;
    } else {
      const match =
        /^(?:BOOKING_CREATED|BOOKING_RESCHEDULED|BOOKING_SCHEDULE_CHANGED|BOOKING_CANCELLED|BOOKING_COMPLETED|PACKAGE_REFUND|NO_SHOW_CHARGED|NO_SHOW_WAIVED|NO_SHOW_CANCELLED):([a-f\d]{24})(?::(\d+))?$/.exec(
          record.eventKey,
        );
      if (!match?.[1]) return false;
      bookingId = new Types.ObjectId(match[1]);
      if (reschedules.has(record.templateKey) && !match[2]) return false;
    }
    const booking = await BookingModel.findById(bookingId).read("primary").maxTimeMS(2000);
    if (!booking || !(await bookingDeliveryPurchaseVerified(booking))) return false;
    if (
      refundEvidence &&
      (String(refundEvidence.businessId) !== String(booking.businessId) ||
        String(refundEvidence.businessClientId) !== String(booking.customer.businessClientId) ||
        String(refundEvidence.customerUserId) !== String(booking.customer.customerUserId) ||
        refundEvidence.expectedRefundAmountCents !== booking.cancellationOutcome?.refundOwedCents ||
        refundEvidence.providerStatus !== booking.cancellationOutcome?.settlementStatus ||
        refundEvidence.providerRefundId !==
          booking.cancellationOutcome?.settlementProviderReference)
    )
      return false;
    if (refundEvidence) {
      const source = await BookingFinancialTransactionModel.findOne({
        _id: refundEvidence.sourceFinancialTransactionId,
        bookingId: booking._id,
        businessId: booking.businessId,
        businessClientId: booking.customer.businessClientId,
        customerUserId: booking.customer.customerUserId,
        type: { $in: ["PLATFORM_FEE", "DEPOSIT"] },
        status: "SUCCEEDED",
        amountCents: refundEvidence.expectedRefundAmountCents,
        currency: refundEvidence.currency,
        providerReference: refundEvidence.sourcePaymentIntentId,
      })
        .read("primary")
        .maxTimeMS(2000);
      if (
        !source ||
        !(await PaymentAttemptModel.findOne({
          providerPaymentIntentId: refundEvidence.sourcePaymentIntentId,
          bookingId: booking._id,
          businessId: booking.businessId,
          businessClientId: booking.customer.businessClientId,
          customerUserId: booking.customer.customerUserId,
          purpose: "BOOKING_DEPOSIT",
          productKind: "NORMAL_BOOKING",
          providerStatus: "SUCCEEDED",
          persistenceStatus: "COMPLETED",
          compensationStatus: "NOT_REQUIRED",
          succeededTransactionId: source._id,
        })
          .read("primary")
          .maxTimeMS(2000))
      )
        return false;
    }
    if (
      record.eventKey.startsWith("BOOKING_CANCELLED:") ||
      record.eventKey.startsWith("BUSINESS_REFUND:")
    ) {
      if (
        !["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_BUSINESS", "LATE_CANCELLATION"].includes(
          booking.status,
        )
      )
        return false;
    }
    if (record.templateKey === "BOOKING_COMPLETED" && booking.status !== "COMPLETED") return false;
    if (
      ["NO_SHOW_CHARGED", "NO_SHOW_WAIVED", "NO_SHOW_CANCELLED"].includes(record.templateKey) &&
      booking.status !== record.templateKey
    )
      return false;
    if (
      [
        "BOOKING_CANCELLED_CUSTOMER",
        "BOOKING_RESCHEDULED_CUSTOMER",
        "BOOKING_CUSTOMER_CONFIRMED",
        "BOOKING_COMPLETED",
        "NO_SHOW_CHARGED",
        "NO_SHOW_WAIVED",
        "NO_SHOW_CANCELLED",
      ].includes(record.templateKey)
    ) {
      if (record.recipient !== booking.customer.contact.normalizedEmail) return false;
    }
    if (
      record.templateKey === "BOOKING_CANCELLED_OWNER" ||
      record.templateKey === "BOOKING_OWNER_NEW_BOOKING"
    ) {
      const business = await BusinessModel.findById(booking.businessId)
        .read("primary")
        .maxTimeMS(2000);
      if (!business) return false;
      const owner = await UserModel.findOne({
        _id: business.ownerUserId,
        status: "ACTIVE",
        normalizedEmail: record.recipient,
      })
        .read("primary")
        .maxTimeMS(2000);
      if (!owner) return false;
    }
    if (
      record.templateKey === "STAFF_BOOKING_CANCELLED" ||
      record.templateKey === "STAFF_BOOKING_SCHEDULE_CHANGED"
    ) {
      const ids = booking.serviceLines.map((line) => line.responsibleStaffMembershipId);
      const members = await StaffMembershipModel.find({
        _id: { $in: ids },
        businessId: booking.businessId,
        employmentActive: true,
        removedAt: { $exists: false },
      })
        .read("primary")
        .maxTimeMS(2000);
      if (
        !members.length ||
        !(await UserModel.exists({
          _id: { $in: members.map((member) => member.userId) },
          normalizedEmail: record.recipient,
          status: "ACTIVE",
        }).maxTimeMS(2000))
      )
        return false;
    }
    if (!activeNotice) return true;
    if (booking.status !== "UPCOMING" || booking.schedule.startAt <= now) return false;
    const p = record.payload,
      tz = booking.schedule.timezone;
    if (confirmations.has(record.templateKey)) {
      if (
        p.reference !== booking.reference ||
        p.appointmentDate !== formatDateInTimezone(booking.schedule.startAt, tz) ||
        p.appointmentTime !== formatTimeInTimezone(booking.schedule.startAt, tz)
      )
        return false;
      const paid = p.onlinePayment as
        | { kind?: string; paymentFor?: "BOOKING" | "PACKAGE_PURCHASE" | "PACKAGE_SESSION_EXTRAS" }
        | undefined;
      if (paid?.kind === "PAID") {
        if (
          !paid.paymentFor ||
          !["BOOKING", "PACKAGE_PURCHASE", "PACKAGE_SESSION_EXTRAS"].includes(paid.paymentFor)
        )
          return false;
        const attempt = await PaymentAttemptModel.findOne({
          bookingId: booking._id,
          businessId: booking.businessId,
          customerUserId: booking.customer.customerUserId,
          businessClientId: booking.customer.businessClientId,
          providerStatus: "SUCCEEDED",
          persistenceStatus: "COMPLETED",
          compensationStatus: "NOT_REQUIRED",
        })
          .read("primary")
          .maxTimeMS(2000);
        if (!attempt?.succeededTransactionId) return false;
        const ledger = await BookingFinancialTransactionModel.findOne({
          _id: attempt.succeededTransactionId,
          bookingId: booking._id,
          businessId: booking.businessId,
          customerUserId: booking.customer.customerUserId,
          businessClientId: booking.customer.businessClientId,
          type: { $in: ["PLATFORM_FEE", "DEPOSIT"] },
        })
          .read("primary")
          .maxTimeMS(2000);
        if (
          !isDeepStrictEqual(
            paid,
            toOnlinePayment({ kind: "CHARGED", attempt, ledger, paymentFor: paid.paymentFor }, tz),
          )
        )
          return false;
      }
      return true;
    }
    const version = Number(record.eventKey.split(":").at(-1));
    if (
      !record.eventKey.startsWith("PACKAGE_LIFECYCLE:") &&
      version !== booking.rescheduleHistory.length
    )
      return false;
    // Customer and staff reschedule templates have different DTOs; customer schedule facts
    // are mandatory, staff notices retain their history-version check above.
    return (
      record.templateKey !== "BOOKING_RESCHEDULED_CUSTOMER" ||
      (p.bookingReference === booking.reference &&
        p.newDate === formatDateInTimezone(booking.schedule.startAt, tz) &&
        p.newTime === formatTimeInTimezone(booking.schedule.startAt, tz))
    );
  }
}

/** Same final eligibility boundary for the existing optional reminder SMS channel. */
export class BookingReminderSmsDeliveryEligibility {
  async check(record: SmsOutboxDocument, now: Date): Promise<boolean> {
    if (!record.eventKey.startsWith("APPOINTMENT_REMINDER_24H:")) return true;
    try {
      if (!record.eventKey.endsWith(":sms")) return false;
      const row = await AppointmentReminderModel.findOne({
        dedupeKey: record.eventKey.slice(0, -4),
      })
        .read("primary")
        .maxTimeMS(2000);
      if (!row || ["CANCELLED", "SKIPPED"].includes(row.status)) return false;
      if (row.smsDecision === "PENDING") throw Error("Reminder enqueue decision not yet committed");
      if (
        row.smsDecision !== "ENQUEUED" ||
        row.smsOutboxDedupeKey !== record.dedupeKey ||
        row.smsRecipientE164 !== record.recipientE164
      )
        return false;
      const booking = await BookingModel.findOne({
        _id: row.bookingId,
        businessId: row.businessId,
        "customer.customerUserId": row.customerUserId,
      })
        .read("primary")
        .maxTimeMS(2000);
      return Boolean(
        booking &&
          booking.status === "UPCOMING" &&
          booking.schedule.startAt > now &&
          booking.schedule.startAt.getTime() === row.scheduleStartAt.getTime() &&
          (await bookingDeliveryPurchaseVerified(booking)),
      );
    } catch (error) {
      throw new SmsError("PROVIDER_TRANSIENT", {
        safeProviderMessage: "Booking delivery eligibility unavailable",
        cause: error,
      });
    }
  }
}
