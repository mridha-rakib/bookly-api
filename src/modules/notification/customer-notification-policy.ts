import {
  type NotificationPreferences,
  resolveNotificationPreferences,
} from "../user/user.types.js";

/**
 * A verified customer phone, for the SMS channel decision. Callers pass this ONLY when the
 * number is genuinely OTP-verified (User.phoneVerifiedAt set) and in E.164 form — see the
 * reminder dispatch wiring. `undefined` = no usable verified number.
 */
export type VerifiedCustomerPhone = { e164: string } | undefined;

/**
 * The one place that decides whether an OPTIONAL customer notification channel may fire.
 *
 * Deliberately tiny and pure — it takes an already-loaded UserProfile.notifications sub-doc
 * (plus, for SMS, an already-resolved verified phone) and answers per channel. It performs no
 * I/O, so it can be called cheaply once per reminder event with data the caller already holds.
 *
 * SCOPE GUARD (structural): this type only knows about OPTIONAL customer channels — the 24h
 * appointment reminder and the marketing-email opt-in. It has no method for — and is never
 * imported by — booking confirmation / cancellation / completion / no-show / CLIENT_CREATED
 * notifiers or the OTP / email-changed security paths. Those remain unconditional. A future
 * optional channel adds a method here; mandatory mail never does.
 *
 * Call this BEFORE enqueuing an optional channel — never from inside a template, an outbox
 * repository/worker, or a provider transport.
 */
export class CustomerNotificationPolicy {
  /** 24h appointment-reminder email. Enabled by product default; the customer can opt out. */
  public mayReceiveAppointmentReminderEmail(
    preferences: NotificationPreferences | undefined,
  ): boolean {
    return resolveNotificationPreferences(preferences).appointmentReminderEmail;
  }

  /**
   * Marketing-email opt-in (Stage M1). Answers ONE question: has this linked customer explicitly
   * opted into marketing email? Product default is OFF, so `undefined` / an absent field / an
   * explicit `false` all return `false`.
   *
   * Deliberately does NOT check the email address, `emailVerifiedAt`, `User.status`, SendGrid
   * suppression state, campaign context, or any business/promo/content eligibility — those are
   * future M3 campaign-eligibility concerns. Nothing in the codebase sends marketing email yet;
   * this method exists so M1 ships a single, testable consent gate.
   */
  public mayReceiveMarketingEmail(preferences: NotificationPreferences | undefined): boolean {
    return resolveNotificationPreferences(preferences).marketingEmail === true;
  }

  /**
   * 24h appointment-reminder SMS. Requires BOTH an explicitly-enabled preference (default OFF)
   * AND a verified E.164 phone — an enabled toggle alone never sends an SMS.
   */
  public mayReceiveAppointmentReminderSms(
    preferences: NotificationPreferences | undefined,
    verifiedPhone: VerifiedCustomerPhone,
  ): boolean {
    if (!resolveNotificationPreferences(preferences).appointmentReminderSms) {
      return false;
    }
    return typeof verifiedPhone?.e164 === "string" && verifiedPhone.e164.length > 0;
  }
}
