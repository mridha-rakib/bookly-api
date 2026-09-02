export const userRoles = [
  "CUSTOMER",
  "BUSINESS_OWNER",
  "SUPERVISOR",
  "STAFF",
  "SUPER_ADMIN",
] as const;

export type UserRole = (typeof userRoles)[number];

export const professionalRoles: UserRole[] = ["BUSINESS_OWNER", "SUPERVISOR", "STAFF"];

// ACTIVE: normal account. DORMANT: existing inactive state. SUSPENDED: admin/platform
// restriction. DELETED: customer-requested account closure (soft delete + anonymization via
// DELETE /auth/me) — a terminal state; login/refresh/`requireActiveUser` all reject it and the
// row's PII has been anonymized (see AuthService.deleteMyAccount).
export const userStatuses = ["ACTIVE", "DORMANT", "SUSPENDED", "DELETED"] as const;

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
 * Scope guard: this governs ONLY optional channels — the 24h "appointment reminder" (see
 * AppointmentReminder domain + CustomerNotificationPolicy) and the marketing-email opt-in
 * (Marketing Email Stage M1 — preference foundation only, nothing sends it yet). None of these
 * can ever suppress mandatory transactional mail (booking confirmation / cancellation /
 * completion / no-show / CLIENT_CREATED) or security mail (OTP / email-changed notice) — those
 * code paths never read this.
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
  /** Marketing-email opt-in (Stage M1). Product default: OFF — consent is never inferred from
   * Terms acceptance, account creation, bookings, or any prior activity; it only becomes
   * meaningful when the real Settings toggle is activated in a later phase. Stage M1 persists
   * the field and exposes {@link CustomerNotificationPolicy.mayReceiveMarketingEmail}; NOTHING
   * sends marketing email yet (no campaign engine, no unsubscribe, no templates). */
  marketingEmail?: boolean | undefined;
};

/**
 * Provenance of the customer's current marketing-email choice (Stage M3A). A plain audit record
 * — eligibility still keys ONLY on {@link NotificationPreferences.marketingEmail}. Optional and
 * additive: legacy rows have no `marketingEmailConsent` and are never backfilled; it is written
 * on the next real mutation of the preference (authenticated Settings PATCH → `"settings"`, the
 * public M2 unsubscribe endpoint → `"unsubscribe"`). `"signup"` / `"import"` are reserved for
 * future consent-capture paths and are not written by anything today.
 */
export const marketingEmailConsentSources = [
  "settings",
  "unsubscribe",
  "signup",
  "import",
] as const;

export type MarketingEmailConsentSource = (typeof marketingEmailConsentSources)[number];

export type MarketingEmailConsent = {
  updatedAt: Date;
  source: MarketingEmailConsentSource;
};

/** Every channel resolved to a concrete boolean (no `undefined`) — the shape API responses and
 * the reminder worker actually consume. */
export type ResolvedNotificationPreferences = {
  appointmentReminderEmail: boolean;
  appointmentReminderSms: boolean;
  marketingEmail: boolean;
};

export const NOTIFICATION_PREFERENCE_DEFAULTS: ResolvedNotificationPreferences = {
  appointmentReminderEmail: true,
  appointmentReminderSms: false,
  marketingEmail: false,
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
  marketingEmail: stored?.marketingEmail ?? NOTIFICATION_PREFERENCE_DEFAULTS.marketingEmail,
});
