/**
 * Mirrors Service's status lifecycle (see service.types.ts): DRAFT tolerates incomplete data
 * and is never customer-facing; ACTIVE/INACTIVE are fully valid (INACTIVE just temporarily
 * hidden); ARCHIVED is soft-deleted and excluded from the normal catalogue. Restoring from
 * ARCHIVED always lands on ACTIVE or INACTIVE, never DRAFT.
 */
export const addonStatuses = ["DRAFT", "ACTIVE", "INACTIVE", "ARCHIVED"] as const;
export type AddonStatus = (typeof addonStatuses)[number];

/** The subset of statuses a client may request directly when creating/editing an Add-on. */
export const editableAddonStatuses = ["DRAFT", "ACTIVE", "INACTIVE"] as const;
export type EditableAddonStatus = (typeof editableAddonStatuses)[number];
