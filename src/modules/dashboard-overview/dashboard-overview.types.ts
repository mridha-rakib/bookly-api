import type { BookingCurrency, BookingStatus } from "../booking/booking.types.js";
import type {
  BookingFinancialTransactionStatus,
  BookingFinancialTransactionType,
} from "../booking-financial-transaction/booking-financial-transaction.types.js";

/**
 * The Business Owner/Supervisor/Staff dashboard "Overview" screen's real backend shape — see
 * DashboardOverview.tsx/SupervisorOverview.tsx/StaffOverview.tsx's own mock data this replaces.
 *
 * `FULL` (BUSINESS_OWNER, SUPERVISOR): every field populated, including `financials` — no
 * product rule currently authorizes STAFF to see Business-wide financial figures (matches
 * FinanceService's own "no canonical product rule granting... Supervisor financial access... [is
 * even narrower]" precedent — Overview is deliberately narrower still for STAFF).
 * `STAFF_SCOPED`: `schedule`/`timeline` contain ONLY this Staff member's own bookings today
 * (never the whole Business's), and `financials` is `null` entirely — matches
 * StaffOverview.tsx's own mock UI, which never renders a financial card for Staff.
 */
export type DashboardOverviewScope = "FULL" | "STAFF_SCOPED";

export type DashboardOverviewLeadType = "NEW_CUSTOMER" | "RETURNING" | "MANUAL";

/** One row of the "Today's schedule" table — mirrors DashboardOverview.tsx's own
 * `scheduleData` row shape (time / name & service / total payment / platform fee / remaining
 * fee / staff / lead). Money fields here are each Booking's OWN validated financial snapshot
 * (`Booking.financials`) — the source of truth for "what this specific appointment charges," a
 * different concept from the ledger-derived AGGREGATE figures in `DashboardOverviewFinancials`
 * below (what has actually settled this month) — see this module's own service-level comment. */
export type DashboardOverviewScheduleRow = {
  bookingId: string;
  bookingReference: string;
  /** Business-local "HH:mm" (see common/time/business-clock.ts). */
  time: string;
  status: BookingStatus;
  customerName: string;
  serviceName: string;
  totalPaymentCents: number;
  platformFeeCents: number;
  remainingFeeCents: number;
  staffName: string;
  leadType: DashboardOverviewLeadType;
};

/** One entry of the "Today's Schedule" timeline card — mirrors `initialTimelineEvents`' own
 * `{time, name, detail, duration}` shape. */
export type DashboardOverviewTimelineEntry = {
  bookingId: string;
  time: string;
  customerName: string;
  detail: string;
  durationMin: number;
};

/** One row of the "Recent activity" feed — mirrors `initialActivityFeed`'s own `{text, time}`
 * shape, built from a real BookingFinancialTransaction ledger row (never a fabricated
 * activity-log entity — see this module's own service-level comment). The frontend is
 * responsible for turning `type`/`status` into the icon/copy (e.g. "New booking deposit
 * collected", "No-show fee charged") — this DTO supplies the facts, not pre-rendered text. */
export type DashboardOverviewActivityEntry = {
  id: string;
  type: BookingFinancialTransactionType;
  status: BookingFinancialTransactionStatus;
  amountCents: number;
  currency: BookingCurrency;
  customerName: string;
  serviceName: string | undefined;
  bookingReference: string | undefined;
  createdAt: Date;
};

/** FULL-scope-only financial figures — every amount here is ledger-derived (via
 * BookingFinancialTransactionService/FinanceService), never `Booking.totalCents`, matching the
 * already-proven pattern in FinanceService. */
export type DashboardOverviewFinancials = {
  /** "To collect today" — the sum of `financials.balanceDueCents` across today's bookings not
   * yet completed (a forward-looking pay-at-venue forecast; no ledger entry exists for money not
   * yet collected — see this module's own service-level comment). */
  payAtVenueDueCents: number;
  noShowMonthCount: number;
  /** Ledger-derived: the sum of SUCCEEDED NO_SHOW_FEE entries this calendar month. */
  noShowMonthChargedCents: number;
  /** The SAME net-payout computation FinanceService.getSummary uses for the Payouts tab
   * (FinanceService.getNetPayoutForBusiness), scoped to this calendar month. */
  monthlyRevenueCents: number;
  recentActivity: DashboardOverviewActivityEntry[];
};

export type DashboardOverview = {
  scope: DashboardOverviewScope;
  currency: BookingCurrency;
  /** Business-local "YYYY-MM-DD" (see common/time/business-clock.ts). */
  todayDateStr: string;
  todayBookingsCount: number;
  /** Bookings today still `UPCOMING` and not yet started. */
  todayRemainingCount: number;
  schedule: DashboardOverviewScheduleRow[];
  timeline: DashboardOverviewTimelineEntry[];
  /** `null` for `STAFF_SCOPED` — see this type's own doc comment. */
  financials: DashboardOverviewFinancials | null;
};
