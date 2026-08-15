/**
 * Roles a BUSINESS_OWNER may assign through Staff Management. Deliberately excludes
 * BUSINESS_OWNER, SUPER_ADMIN, and CUSTOMER — see staff.schema.ts / staff.service.ts for
 * the server-side enforcement that backs this allowlist (never trust the client for this).
 */
export const staffCreatableRoles = ["SUPERVISOR", "STAFF"] as const;

export type StaffCreatableRole = (typeof staffCreatableRoles)[number];

/** Display-only role union used by the Staff list DTO (adds the synthesized Owner row). */
export type StaffDisplayRole = "BUSINESS_OWNER" | StaffCreatableRole;
