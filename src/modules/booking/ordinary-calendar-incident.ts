import type { OrdinaryCalendarJournalDocument } from "./ordinary-calendar-journal.model.js";

/**
 * P4B-2C — durable incident classification for ordinary Calendar monitoring, and the Owner's
 * per-Booking sync status. Pure: no provider call, no Booking or financial write.
 *
 * Thresholds: the only window used here is the one the consumer already uses for safety (an
 * issued request older than the issuer window is reconciled), passed in by the caller. Alert
 * severities, paging thresholds for `retryableFailures` and notification routing are NOT
 * defined in source; they are an operations decision (see the P4B-2C result report).
 */
export const ordinaryCalendarIncidentCategories = [
  "PROVIDER_OUTCOME_UNKNOWN",
  "REQUEST_STUCK_BEYOND_OBSERVATION_WINDOW",
  "PROVIDER_RETRYING",
  "CONNECTION_OR_DESTINATION_MISMATCH",
  "CALENDAR_NOT_CONNECTED",
  "BOOKING_AUTHORITY_CHECK_FAILED",
  "PROVIDER_PERMANENT_FAILURE",
] as const;
export type OrdinaryCalendarIncidentCategory = (typeof ordinaryCalendarIncidentCategories)[number];

export type OrdinaryCalendarIncident = {
  category: OrdinaryCalendarIncidentCategory;
  /** True when only an explicit Owner/operator decision can move the Booking forward. */
  recoveryRequired: boolean;
  journalId: string;
  bookingId: string;
  businessId: string;
  state: OrdinaryCalendarJournalDocument["state"];
  reason?: string | undefined;
  unresolvedRequestId?: string | undefined;
  retryableFailures: number;
};

const BOOKING_AUTHORITY_REASONS = new Set([
  "BOOKING_NOT_FOUND_FOR_BUSINESS",
  "NOT_AN_ORDINARY_BOOKING",
  "BOOKING_IDENTITY_MISMATCH",
  "LEGACY_EVENT_LINK_PRESENT",
  "BUSINESS_NOT_FOUND",
  "BOOKING_STATUS_WITHOUT_CALENDAR_INTENT",
  "BOOKING_JOURNAL_REVISION_MISMATCH",
  "EVENT_IDENTITY_NOT_ALLOCATED",
]);

type JournalView = Pick<
  OrdinaryCalendarJournalDocument,
  "_id" | "bookingId" | "businessId" | "mode" | "state" | "reason" | "request" | "retryableFailures"
>;

export function classifyOrdinaryCalendarIncident(
  journal: JournalView,
  now: Date,
  stuckAfterMs: number,
): OrdinaryCalendarIncident | null {
  if (journal.mode !== "AUTHORITATIVE") return null;
  const unresolved = journal.request && !journal.request.settled ? journal.request : undefined;
  const base = {
    journalId: String(journal._id),
    bookingId: String(journal.bookingId),
    businessId: String(journal.businessId),
    state: journal.state,
    reason: journal.reason,
    unresolvedRequestId: unresolved?.id,
    retryableFailures: journal.retryableFailures ?? 0,
  };
  const incident = (category: OrdinaryCalendarIncidentCategory, recoveryRequired: boolean) => ({
    ...base,
    category,
    recoveryRequired,
  });
  const reason = journal.reason ?? "";
  switch (journal.state) {
    case "UNKNOWN_OUTCOME":
      return incident("PROVIDER_OUTCOME_UNKNOWN", true);
    case "REQUEST_ISSUED":
      return unresolved && unresolved.issuedAt.getTime() <= now.getTime() - stuckAfterMs
        ? incident("REQUEST_STUCK_BEYOND_OBSERVATION_WINDOW", false)
        : null;
    case "RETRYABLE_FAILURE":
      return (journal.retryableFailures ?? 0) >= 1 ? incident("PROVIDER_RETRYING", false) : null;
    case "BLOCKED_AUTHORITY":
      if (reason === "CALENDAR_NOT_CONNECTED_AT_CREATION")
        return incident("CALENDAR_NOT_CONNECTED", true);
      if (BOOKING_AUTHORITY_REASONS.has(reason))
        return incident("BOOKING_AUTHORITY_CHECK_FAILED", true);
      return incident("CONNECTION_OR_DESTINATION_MISMATCH", true);
    case "PERMANENT_FAILURE":
      return BOOKING_AUTHORITY_REASONS.has(reason)
        ? incident("BOOKING_AUTHORITY_CHECK_FAILED", true)
        : incident("PROVIDER_PERMANENT_FAILURE", true);
    default:
      return null;
  }
}

export type OrdinaryCalendarSyncStatus = {
  /** LEGACY: the pre-journal best-effort path owns this Booking; its sync is not tracked. */
  ownership: "LEGACY" | "JOURNAL";
  status:
    | "LEGACY_UNTRACKED"
    | "SYNCED"
    | "SYNC_PENDING"
    | "NOT_CONNECTED"
    | "RECOVERY_REQUIRED"
    | "RETRYING";
  state?: OrdinaryCalendarJournalDocument["state"];
  reason?: string | undefined;
  incident?: OrdinaryCalendarIncidentCategory | undefined;
  recoveryRequired: boolean;
  unresolvedRequestId?: string | undefined;
  desired?: "PRESENT" | "ABSENT";
  latestSequence?: number;
  confirmedSequence?: number | undefined;
  destination?:
    | { accountEmail: string; configuredCalendarId: string; generation: string }
    | undefined;
  recoveries?: number;
};

/** Owner-facing status. A Booking is only ever reported SYNCED after a confirmed observation;
 * a legacy-owned Booking is reported as untracked, never as synchronized. No secrets. */
export function describeOrdinaryCalendarSync(
  journal:
    | (JournalView &
        Pick<
          OrdinaryCalendarJournalDocument,
          "latest" | "confirmedSequence" | "destination" | "recoveries"
        >)
    | null,
  now: Date,
  stuckAfterMs: number,
): OrdinaryCalendarSyncStatus {
  if (!journal || journal.mode !== "AUTHORITATIVE")
    return { ownership: "LEGACY", status: "LEGACY_UNTRACKED", recoveryRequired: false };
  const incident = classifyOrdinaryCalendarIncident(journal, now, stuckAfterMs);
  const status: OrdinaryCalendarSyncStatus["status"] =
    journal.state === "CONFIRMED" && journal.confirmedSequence === journal.latest.sequence
      ? "SYNCED"
      : incident?.category === "CALENDAR_NOT_CONNECTED"
        ? "NOT_CONNECTED"
        : incident?.recoveryRequired
          ? "RECOVERY_REQUIRED"
          : incident?.category === "PROVIDER_RETRYING"
            ? "RETRYING"
            : "SYNC_PENDING";
  return {
    ownership: "JOURNAL",
    status,
    state: journal.state,
    reason: journal.reason,
    incident: incident?.category,
    recoveryRequired: incident?.recoveryRequired ?? false,
    unresolvedRequestId:
      journal.request && !journal.request.settled ? journal.request.id : undefined,
    desired: journal.latest.desired.kind,
    latestSequence: journal.latest.sequence,
    confirmedSequence: journal.confirmedSequence,
    destination: journal.destination
      ? {
          accountEmail: journal.destination.accountEmail,
          configuredCalendarId: journal.destination.configuredCalendarId,
          generation: journal.destination.generation,
        }
      : undefined,
    recoveries: journal.recoveries?.length ?? 0,
  };
}
