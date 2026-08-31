export const userRoles = [
  "CUSTOMER",
  "BUSINESS_OWNER",
  "SUPERVISOR",
  "STAFF",
  "SUPER_ADMIN",
] as const;

export type UserRole = (typeof userRoles)[number];

export const professionalRoles: UserRole[] = ["BUSINESS_OWNER", "SUPERVISOR", "STAFF"];

export const userStatuses = ["ACTIVE", "DORMANT", "SUSPENDED"] as const;

export type UserStatus = (typeof userStatuses)[number];

export const genders = ["male", "female", "other"] as const;

export type Gender = (typeof genders)[number];

// Account-level UI language preference (Super Admin Settings → Admin Account). Persisted only;
// this codebase has no i18n/translation layer, so the value is stored and echoed back, nothing
// localizes text from it yet.
export const userLanguages = ["EN", "GR"] as const;

export type UserLanguage = (typeof userLanguages)[number];

export type PhoneNumber = {
  countryCode: string;
  nationalNumber: string;
  e164: string;
};

/**
 * Customer-configurable OPTIONAL notification channels. Persisted on UserProfile.notifications.
 *
 * Scope guard: this governs ONLY the 24h "appointment reminder" (see AppointmentReminder domain
 * + CustomerNotificationPolicy). It can never suppress mandatory transactional mail (booking
 * confirmation / cancellation / completion / no-show / CLIENT_CREATED) or security mail
 * (OTP / email-changed notice) — those code paths never read this.
 *
 * An absent sub-doc, or an absent individual field, means "use the product default"
 * ({@link NOTIFICATION_PREFERENCE_DEFAULTS}). That keeps legacy UserProfile rows correct with no
 * migration — {@link resolveNotificationPreferences} applies the defaults at read time.
 */
export type NotificationPreferences = {
  /** 24h-before appointment reminder email. Product default: ON (matches the existing Settings
   * presentation and the fact that customers already receive booking mail). */
  appointmentReminderEmail?: boolean | undefined;
  /** 24h-before appointment reminder SMS. Product default: OFF — a brand-new channel, opt-in
   * only, so shipping this feature never creates unsolicited SMS traffic for existing customers. */
  appointmentReminderSms?: boolean | undefined;
};

/** Every channel resolved to a concrete boolean (no `undefined`) — the shape API responses and
 * the reminder worker actually consume. */
export type ResolvedNotificationPreferences = {
  appointmentReminderEmail: boolean;
  appointmentReminderSms: boolean;
};

export const NOTIFICATION_PREFERENCE_DEFAULTS: ResolvedNotificationPreferences = {
  appointmentReminderEmail: true,
  appointmentReminderSms: false,
};

/** Resolves a possibly-absent stored sub-doc into a fully-populated preference set, applying
 * {@link NOTIFICATION_PREFERENCE_DEFAULTS} for any missing field. The single place the "absent
 * means default" rule lives — API responses and the reminder worker both go through this. */
export const resolveNotificationPreferences = (
  stored: NotificationPreferences | undefined,
): ResolvedNotificationPreferences => ({
  appointmentReminderEmail:
    stored?.appointmentReminderEmail ?? NOTIFICATION_PREFERENCE_DEFAULTS.appointmentReminderEmail,
  appointmentReminderSms:
    stored?.appointmentReminderSms ?? NOTIFICATION_PREFERENCE_DEFAULTS.appointmentReminderSms,
});
