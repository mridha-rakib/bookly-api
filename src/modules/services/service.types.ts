/**
 * DRAFT = not yet publish-ready, may hold incomplete data, never customer-facing, editable
 * indefinitely. ACTIVE/INACTIVE = fully valid Services in the normal catalogue (INACTIVE is
 * just temporarily hidden). ARCHIVED = soft-deleted, excluded from the catalogue, never hard
 * deleted so historical booking references stay valid. A Service can only reach
 * ACTIVE/INACTIVE by passing full validation — DRAFT is the only status that tolerates
 * incomplete data, and restoring from ARCHIVED always lands on ACTIVE or INACTIVE, never DRAFT.
 */
export const serviceStatuses = ["DRAFT", "ACTIVE", "INACTIVE", "ARCHIVED"] as const;
export type ServiceStatus = (typeof serviceStatuses)[number];

/** The subset of statuses a client may request directly when creating/editing a Service. */
export const editableServiceStatuses = ["DRAFT", "ACTIVE", "INACTIVE"] as const;
export type EditableServiceStatus = (typeof editableServiceStatuses)[number];

/** Applies only when isPackageDeal is false — a Package Deal has its own fixed field set. */
export const servicePricingModes = ["FIXED", "HOURLY", "PER_PERSON"] as const;
export type ServicePricingMode = (typeof servicePricingModes)[number];

/**
 * AUTO = Service uses the Business's general schedule (not modeled yet on Business — the
 * booking engine will read Service.scheduleMode when it exists). MANUAL = the Figma "Custom
 * schedule for this service" toggle ON — fixed time slots below override the Business's
 * general hours for this Service only.
 */
export const serviceScheduleModes = ["AUTO", "MANUAL"] as const;
export type ServiceScheduleMode = (typeof serviceScheduleModes)[number];
