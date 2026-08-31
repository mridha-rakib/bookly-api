import type { RenderedEmail } from "./email.types.js";
import {
  type BusinessRegisteredEmailData,
  renderBusinessRegisteredEmail,
} from "./templates/admin/business-registered.template.js";
import {
  type AppointmentReminderEmailData,
  renderAppointmentReminder24hEmail,
} from "./templates/booking/appointment-reminder-24h.template.js";
import { renderBookingCancelledCustomerEmail } from "./templates/booking/booking-cancelled-customer.template.js";
import { renderBookingCancelledOwnerEmail } from "./templates/booking/booking-cancelled-owner.template.js";
import {
  type BookingCompletedEmailPayload,
  renderBookingCompletedEmail,
} from "./templates/booking/booking-completed.template.js";
import { renderBookingCustomerConfirmedEmail } from "./templates/booking/booking-customer-confirmed.template.js";
import type { BookingEmailData } from "./templates/booking/booking-email-data.js";
import { renderBookingForClientConfirmedEmail } from "./templates/booking/booking-for-client-confirmed.template.js";
import { renderBookingOwnerNewBookingEmail } from "./templates/booking/booking-owner-new-booking.template.js";
import {
  type BookingRescheduledEmailData,
  renderBookingRescheduledCustomerEmail,
} from "./templates/booking/booking-rescheduled-customer.template.js";
import {
  renderBookingStaffCreatedEmail,
  type StaffCreatedBookingEmailData,
} from "./templates/booking/booking-staff-created.template.js";
import type { CancellationEmailData } from "./templates/booking/cancellation-email-data.js";
import { renderNoShowCancelledEmail } from "./templates/booking/no-show-cancelled.template.js";
import { renderNoShowChargedEmail } from "./templates/booking/no-show-charged.template.js";
import type { NoShowEmailData } from "./templates/booking/no-show-email-data.js";
import { renderNoShowWaivedEmail } from "./templates/booking/no-show-waived.template.js";
import {
  type ClientCreatedEmailData,
  renderClientCreatedEmail,
} from "./templates/client/client-created.template.js";
import {
  type OtpVerificationPayload,
  renderOtpVerificationEmail,
} from "./templates/otp/otp-verification.template.js";
import {
  renderStaffAccessRemovedEmail,
  type StaffAccessRemovedPayload,
} from "./templates/staff/staff-access-removed.template.js";
import {
  renderStaffBookingCancelledEmail,
  type StaffBookingCancelledPayload,
} from "./templates/staff/staff-booking-cancelled.template.js";
import {
  renderStaffBookingScheduleChangedEmail,
  type StaffBookingScheduleChangedPayload,
} from "./templates/staff/staff-booking-schedule-changed.template.js";
import {
  renderStaffDeactivatedEmail,
  type StaffDeactivatedPayload,
} from "./templates/staff/staff-deactivated.template.js";
import {
  renderStaffReactivatedEmail,
  type StaffReactivatedPayload,
} from "./templates/staff/staff-reactivated.template.js";
import {
  renderStaffRoleChangedEmail,
  type StaffRoleChangedPayload,
} from "./templates/staff/staff-role-changed.template.js";

/**
 * Typed registry of outbox-deliverable email templates (Phase T). The union lists every key the
 * mailing system will eventually emit; the registry object only maps keys that have a real
 * renderer TODAY. Stage C/D add the rest — no placeholder bodies are registered now.
 */
export type EmailTemplateKey =
  | "OTP_VERIFICATION"
  // Stage B — client + booking creation
  | "CLIENT_CREATED"
  | "BOOKING_CUSTOMER_CONFIRMED"
  | "BOOKING_OWNER_NEW_BOOKING"
  | "BOOKING_FOR_CLIENT_CONFIRMED"
  | "BOOKING_STAFF_CREATED_NOTIFICATION"
  // Stage C — booking completed + invoice
  | "BOOKING_COMPLETED"
  // Appointment reminder (optional, preference-gated — NOT a mandatory booking email)
  | "APPOINTMENT_REMINDER_24H"
  // Mandatory customer transactional email — appointment schedule changed (customer or business)
  | "BOOKING_RESCHEDULED_CUSTOMER"
  // Stage D — cancellation + no-show + business registration
  | "BOOKING_CANCELLED_CUSTOMER"
  | "BOOKING_CANCELLED_OWNER"
  | "NO_SHOW_CHARGED"
  | "NO_SHOW_WAIVED"
  | "NO_SHOW_CANCELLED"
  | "BUSINESS_REGISTERED"
  // Important staff notifications — assigned-booking lifecycle + team-access removal
  | "STAFF_BOOKING_CANCELLED"
  | "STAFF_BOOKING_SCHEDULE_CHANGED"
  | "STAFF_ACCESS_REMOVED"
  // Staff access-state changes (backed by a persisted StaffAccessEvent)
  | "STAFF_ROLE_CHANGED"
  | "STAFF_DEACTIVATED"
  | "STAFF_REACTIVATED";

export type EmailTemplateRenderer<P = never> = (payload: P) => RenderedEmail;

/** Raised when the worker is handed an outbox row whose template has no registered renderer. */
export class EmailTemplateNotRegisteredError extends Error {
  public constructor(public readonly templateKey: string) {
    super(`No email template renderer registered for "${templateKey}"`);
    this.name = "EmailTemplateNotRegisteredError";
  }
}

const asRenderer = <P>(fn: (payload: P) => RenderedEmail): EmailTemplateRenderer<never> =>
  fn as EmailTemplateRenderer<never>;

const registry: Partial<Record<EmailTemplateKey, EmailTemplateRenderer<never>>> = {
  OTP_VERIFICATION: asRenderer<OtpVerificationPayload>(renderOtpVerificationEmail),
  CLIENT_CREATED: asRenderer<ClientCreatedEmailData>(renderClientCreatedEmail),
  BOOKING_CUSTOMER_CONFIRMED: asRenderer<BookingEmailData>(renderBookingCustomerConfirmedEmail),
  BOOKING_OWNER_NEW_BOOKING: asRenderer<BookingEmailData>(renderBookingOwnerNewBookingEmail),
  BOOKING_FOR_CLIENT_CONFIRMED: asRenderer<BookingEmailData>(renderBookingForClientConfirmedEmail),
  BOOKING_STAFF_CREATED_NOTIFICATION: asRenderer<StaffCreatedBookingEmailData>(
    renderBookingStaffCreatedEmail,
  ),
  BOOKING_COMPLETED: asRenderer<BookingCompletedEmailPayload>(renderBookingCompletedEmail),
  APPOINTMENT_REMINDER_24H: asRenderer<AppointmentReminderEmailData>(
    renderAppointmentReminder24hEmail,
  ),
  BOOKING_RESCHEDULED_CUSTOMER: asRenderer<BookingRescheduledEmailData>(
    renderBookingRescheduledCustomerEmail,
  ),
  BOOKING_CANCELLED_CUSTOMER: asRenderer<CancellationEmailData>(
    renderBookingCancelledCustomerEmail,
  ),
  BOOKING_CANCELLED_OWNER: asRenderer<CancellationEmailData>(renderBookingCancelledOwnerEmail),
  NO_SHOW_CHARGED: asRenderer<NoShowEmailData>(renderNoShowChargedEmail),
  NO_SHOW_WAIVED: asRenderer<NoShowEmailData>(renderNoShowWaivedEmail),
  NO_SHOW_CANCELLED: asRenderer<NoShowEmailData>(renderNoShowCancelledEmail),
  BUSINESS_REGISTERED: asRenderer<BusinessRegisteredEmailData>(renderBusinessRegisteredEmail),
  STAFF_BOOKING_CANCELLED: asRenderer<StaffBookingCancelledPayload>(
    renderStaffBookingCancelledEmail,
  ),
  STAFF_BOOKING_SCHEDULE_CHANGED: asRenderer<StaffBookingScheduleChangedPayload>(
    renderStaffBookingScheduleChangedEmail,
  ),
  STAFF_ACCESS_REMOVED: asRenderer<StaffAccessRemovedPayload>(renderStaffAccessRemovedEmail),
  STAFF_ROLE_CHANGED: asRenderer<StaffRoleChangedPayload>(renderStaffRoleChangedEmail),
  STAFF_DEACTIVATED: asRenderer<StaffDeactivatedPayload>(renderStaffDeactivatedEmail),
  STAFF_REACTIVATED: asRenderer<StaffReactivatedPayload>(renderStaffReactivatedEmail),
};

export const isEmailTemplateRegistered = (key: EmailTemplateKey): boolean => key in registry;

export const renderEmailTemplate = (key: EmailTemplateKey, payload: unknown): RenderedEmail => {
  const renderer = registry[key];
  if (!renderer) {
    throw new EmailTemplateNotRegisteredError(key);
  }
  return (renderer as EmailTemplateRenderer<unknown>)(payload);
};
