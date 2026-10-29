import { Types } from "mongoose";
import { afterEach, expect, it, vi } from "vitest";
import { AppointmentReminderModel } from "../../src/modules/appointment-reminder/appointment-reminder.model.js";
import { BookingModel } from "../../src/modules/booking/booking.model.js";
import {
  BookingEmailDeliveryEligibility,
  BookingReminderSmsDeliveryEligibility,
  bookingDeliveryPurchaseVerified,
} from "../../src/modules/booking/booking-email-delivery-eligibility.js";
import {
  formatDateInTimezone,
  formatTimeInTimezone,
} from "../../src/modules/email/templates/components/email-format.js";
import type { EmailOutboxDocument } from "../../src/modules/email-outbox/email-outbox.model.js";
import { PackageProgressV2Model } from "../../src/modules/package-progress/package-progress-v2.model.js";
import * as ownership from "../../src/modules/package-progress/package-view.service.js";
import { PaymentAttemptModel } from "../../src/modules/payment/payment-attempt.model.js";
import { RefundOperationModel } from "../../src/modules/payment/refund-operation.model.js";
import { StaffMembershipModel } from "../../src/modules/staff/staff.model.js";

const id = new Types.ObjectId(),
  businessId = new Types.ObjectId(),
  customerId = new Types.ObjectId();
const now = new Date("2030-08-19T08:00:00Z"),
  start = new Date("2030-08-20T08:00:00Z");
const booking = () => ({
  _id: id,
  businessId,
  status: "UPCOMING",
  reference: "BK-REAL",
  serviceLines: [{ pricingInput: {} }],
  customer: {
    customerUserId: customerId,
    businessClientId: new Types.ObjectId(),
    contact: { normalizedEmail: "customer@example.test" },
  },
  schedule: {
    startAt: start,
    endAt: new Date(start.getTime() + 3600000),
    timezone: "Europe/Nicosia",
  },
  rescheduleHistory: [],
});
const row = (templateKey = "BOOKING_CUSTOMER_CONFIRMED"): EmailOutboxDocument => ({
  _id: new Types.ObjectId(),
  eventKey: `BOOKING_CREATED:${id}`,
  templateKey,
  recipient: "customer@example.test",
  dedupeKey: "exact-outbox",
  payload: {
    reference: "BK-REAL",
    appointmentDate: formatDateInTimezone(start, "Europe/Nicosia"),
    appointmentTime: formatTimeInTimezone(start, "Europe/Nicosia"),
  },
  status: "PROCESSING",
  attemptCount: 1,
  createdAt: now,
  updatedAt: now,
});
const query = (value: unknown) => ({ read: () => ({ maxTimeMS: async () => value }) }) as never;
afterEach(() => vi.restoreAllMocks());
it.each(["CANCELLED_BY_CUSTOMER", "COMPLETED", "PENDING", "NO_SHOW_CHARGED"])(
  "queued confirmation is retired before send for %s",
  async (status) => {
    vi.spyOn(BookingModel, "findById").mockReturnValue(query({ ...booking(), status }));
    expect(await new BookingEmailDeliveryEligibility().check(row(), now)).toBe(false);
  },
);
it("current confirmation uses exact business-local schedule, while an old rescheduled snapshot is rejected", async () => {
  vi.spyOn(BookingModel, "findById").mockReturnValue(query(booking()));
  expect(await new BookingEmailDeliveryEligibility().check(row(), now)).toBe(true);
  const stale = row();
  stale.payload.appointmentTime = "wrong";
  expect(await new BookingEmailDeliveryEligibility().check(stale, now)).toBe(false);
});
it.each(["CANCELLED", "SKIPPED"])(
  "queued reminder email and SMS refuse retired orchestration %s",
  async (status) => {
    vi.spyOn(AppointmentReminderModel, "findOne").mockReturnValue(query({ status }));
    const email = {
      ...row("APPOINTMENT_REMINDER_24H"),
      eventKey: `APPOINTMENT_REMINDER_24H:${id}:${start.getTime()}`,
    };
    expect(await new BookingEmailDeliveryEligibility().check(email, now)).toBe(false);
    expect(
      await new BookingReminderSmsDeliveryEligibility().check(
        { eventKey: `${email.eventKey}:sms` } as never,
        now,
      ),
    ).toBe(false);
  },
);
it.each(["cancelled", "moved", "late", "foreign"])(
  "email reminder final dispatch refuses %s Booking state",
  async (condition) => {
    const email = {
      ...row("APPOINTMENT_REMINDER_24H"),
      eventKey: `APPOINTMENT_REMINDER_24H:${id}:${start.getTime()}`,
    };
    vi.spyOn(AppointmentReminderModel, "findOne").mockReturnValue(
      query({
        status: "COMPLETED",
        kind: "REMINDER_24H",
        bookingId: id,
        businessId,
        customerUserId: customerId,
        scheduleStartAt: start,
        emailDecision: "ENQUEUED",
        emailOutboxDedupeKey: email.dedupeKey,
        emailRecipient: email.recipient,
      }),
    );
    const target = booking();
    vi.spyOn(BookingModel, "findOne").mockReturnValue(
      query(
        condition === "foreign"
          ? null
          : condition === "cancelled"
            ? { ...target, status: "CANCELLED_BY_BUSINESS" }
            : condition === "moved"
              ? {
                  ...target,
                  schedule: { ...target.schedule, startAt: new Date(start.getTime() + 60000) },
                }
              : target,
      ),
    );
    expect(
      await new BookingEmailDeliveryEligibility().check(email, condition === "late" ? start : now),
    ).toBe(false);
  },
);
it("enqueue/decision race and storage outage retry without provider authority", async () => {
  vi.spyOn(AppointmentReminderModel, "findOne").mockReturnValue(
    query({ status: "PROCESSING", emailDecision: "PENDING" }),
  );
  await expect(
    new BookingEmailDeliveryEligibility().check(row("APPOINTMENT_REMINDER_24H"), now),
  ).rejects.toMatchObject({ retryable: true, category: "PROVIDER_TRANSIENT" });
});
it("a physically present Package member requires genuine public purchase proof", async () => {
  const target = booking();
  target.serviceLines = [{ pricingInput: { packageItemId: id, packageProgressId: id } }] as never;
  vi.spyOn(PackageProgressV2Model, "findOne").mockReturnValue(query({ _id: id }));
  const verify = vi
    .spyOn(ownership, "readPackagePurchaseCompletion")
    .mockResolvedValue("NOT_ESTABLISHED");
  expect(await bookingDeliveryPurchaseVerified(target as never)).toBe(false);
  verify.mockResolvedValue("VERIFIED");
  expect(await bookingDeliveryPurchaseVerified(target as never)).toBe(true);
});
it("a queued receipt's PAID text is not payment authority when the durable attempt is absent", async () => {
  vi.spyOn(BookingModel, "findById").mockReturnValue(query(booking()));
  vi.spyOn(PaymentAttemptModel, "findOne").mockReturnValue(query(null));
  const email = row();
  email.payload.onlinePayment = {
    kind: "PAID",
    paymentFor: "BOOKING",
    paymentReference: "pi_forged",
  };
  expect(await new BookingEmailDeliveryEligibility().check(email, now)).toBe(false);
});
it("staff reschedule notice refuses an unassigned or removed membership before sending", async () => {
  vi.spyOn(BookingModel, "findById").mockReturnValue(
    query({
      ...booking(),
      serviceLines: [
        {
          pricingInput: {},
          responsibleStaffMembershipId: new Types.ObjectId(),
        },
      ],
      rescheduleHistory: [{ previousStart: new Date(start.getTime() - 3600000), newStart: start }],
    }),
  );
  vi.spyOn(StaffMembershipModel, "find").mockReturnValue(query([]));
  const email = {
    ...row("STAFF_BOOKING_SCHEDULE_CHANGED"),
    eventKey: `BOOKING_SCHEDULE_CHANGED:${id}:1`,
  };
  expect(await new BookingEmailDeliveryEligibility().check(email, now)).toBe(false);
});
it("refund settlement wording cannot send from payload text without the exact RefundOperation", async () => {
  const operationId = new Types.ObjectId();
  vi.spyOn(RefundOperationModel, "findOne").mockReturnValue(query(null));
  const email = {
    ...row("BOOKING_CANCELLED_CUSTOMER"),
    eventKey: `BUSINESS_REFUND:${id}:${operationId}:SUCCEEDED`,
    payload: { financialOutcome: { settlementStatus: "SUCCEEDED" } },
  };
  expect(await new BookingEmailDeliveryEligibility().check(email, now)).toBe(false);
});
it("unchanged upcoming reminder is allowed but cancelled SMS is refused at final provider boundary", async () => {
  const email = {
    ...row("APPOINTMENT_REMINDER_24H"),
    eventKey: `APPOINTMENT_REMINDER_24H:${id}:${start.getTime()}`,
  };
  vi.spyOn(AppointmentReminderModel, "findOne").mockReturnValue(
    query({
      status: "COMPLETED",
      kind: "REMINDER_24H",
      bookingId: id,
      businessId,
      customerUserId: customerId,
      scheduleStartAt: start,
      emailDecision: "ENQUEUED",
      emailOutboxDedupeKey: email.dedupeKey,
      emailRecipient: email.recipient,
      smsDecision: "ENQUEUED",
      smsOutboxDedupeKey: "sms-key",
      smsRecipientE164: "+35799112233",
    }),
  );
  const read = vi.spyOn(BookingModel, "findOne").mockReturnValue(query(booking()));
  expect(await new BookingEmailDeliveryEligibility().check(email, now)).toBe(true);
  read.mockReturnValue(query({ ...booking(), status: "CANCELLED_BY_CUSTOMER" }));
  expect(
    await new BookingReminderSmsDeliveryEligibility().check(
      {
        eventKey: `${email.eventKey}:sms`,
        dedupeKey: "sms-key",
        recipientE164: "+35799112233",
      } as never,
      now,
    ),
  ).toBe(false);
});
