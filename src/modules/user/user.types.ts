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
