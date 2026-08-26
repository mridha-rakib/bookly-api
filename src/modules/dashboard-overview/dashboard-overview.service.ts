import { Types } from "mongoose";

import {
  addCalendarDays,
  addCalendarMonths,
  businessLocalToUtc,
  utcToBusinessLocalDate,
  utcToBusinessLocalTime,
} from "../../common/time/business-clock.js";
import type { BookingDocument } from "../booking/booking.model.js";
import type { BookingRepository } from "../booking/booking.repository.js";
import type { BookingFinancialTransactionDocument } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { FinanceService } from "../finance/finance.service.js";
import type { StaffRepository } from "../staff/staff.repository.js";
import type { UserRole } from "../user/user.types.js";
import { DashboardOverviewError } from "./dashboard-overview.errors.js";
import type {
  DashboardOverview,
  DashboardOverviewActivityEntry,
  DashboardOverviewFinancials,
  DashboardOverviewLeadType,
  DashboardOverviewScheduleRow,
  DashboardOverviewTimelineEntry,
} from "./dashboard-overview.types.js";

/** Dashboard Overview's "Recent activity" feed bound — see
 * BookingFinancialTransactionService.listRecentForBusiness's own comment. */
const RECENT_ACTIVITY_LIMIT = 10;

type ResolvedScope =
  | { kind: "FULL"; business: BusinessDocument }
  | { kind: "STAFF"; business: BusinessDocument; staffMembershipId: Types.ObjectId };

/**
 * Real, backend-scoped aggregation for the Business Owner/Supervisor/Staff dashboard "Overview"
 * screen — replaces the 100% hardcoded mock data in DashboardOverview.tsx/SupervisorOverview.tsx/
 * StaffOverview.tsx (frontend consumption is a separate, later pass).
 *
 * Authorization mirrors BookingService.requireBookingManagementAccess exactly for OWNER/
 * SUPERVISOR (see `resolveScope` below) — same 404-never-a-bare-403 anti-enumeration convention.
 * STAFF is a NEW authorization surface this module introduces (no existing route grants STAFF
 * access to anything in this codebase yet): a STAFF actor may read a scoped-down Overview of
 * their OWN business — their own bookings/schedule only, re-derived from their own active
 * StaffMembership row exactly like AuthService.resolveMeBusiness does for `/auth/me`, never from
 * a client-supplied staffMembershipId.
 *
 * Financial figures (`financials.*`) are ledger-derived via BookingFinancialTransactionService/
 * FinanceService — never `Booking.totalCents` — matching FinanceService's own already-proven
 * pattern. The one exception is `financials.payAtVenueDueCents` ("To collect today"): this is a
 * forward-looking forecast of cash not yet collected, so by definition no ledger entry exists
 * for it yet; it reads `Booking.financials.balanceDueCents`, the Booking's own validated
 * structural field for exactly this concept (see BookingCompletionPayment's own doc comment:
 * "whether the customer paid the remaining `financials.balanceDueCents` at the venue"), which is
 * a different field from — and not a proxy for — the `totalCents` this task's constraints
 * disallow using as an aggregate-revenue source. The "Today's schedule" table's per-row money
 * columns are the same kind of per-booking structural read, not an aggregate revenue figure.
 */
export class DashboardOverviewService {
  public constructor(
    private readonly businessRepository: BusinessRepository,
    private readonly staffRepository: StaffRepository,
    private readonly bookingRepository: BookingRepository,
    private readonly financialTransactionService: BookingFinancialTransactionService,
    private readonly financeService: FinanceService,
  ) {}

  public async getOverview(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
  ): Promise<DashboardOverview> {
    const scope = await this.resolveScope(actorUserId, actorRole, businessId);
    const business = scope.business;
    const now = new Date();

    const { dateStr } = utcToBusinessLocalDate(business.timezone, now);
    const dayStart = businessLocalToUtc(business.timezone, dateStr, "00:00");
    const dayEnd = businessLocalToUtc(business.timezone, addCalendarDays(dateStr, 1), "00:00");

    const staffMembershipId = scope.kind === "STAFF" ? scope.staffMembershipId : undefined;
    const todaysBookings = await this.bookingRepository.findScheduleForBusinessOnDate(
      business._id,
      dayStart,
      dayEnd,
      staffMembershipId,
    );

    const schedule = todaysBookings.map((booking) =>
      this.toScheduleRow(booking, business.timezone),
    );
    const timeline = todaysBookings.map((booking) =>
      this.toTimelineEntry(booking, business.timezone),
    );
    const todayRemainingCount = todaysBookings.filter(
      (booking) => booking.status === "UPCOMING" && booking.schedule.startAt >= now,
    ).length;

    const financials =
      scope.kind === "FULL" ? await this.buildFinancials(business, dateStr, todaysBookings) : null;

    return {
      scope: scope.kind === "FULL" ? "FULL" : "STAFF_SCOPED",
      currency: "EUR",
      todayDateStr: dateStr,
      todayBookingsCount: todaysBookings.length,
      todayRemainingCount,
      schedule,
      timeline,
      financials,
    };
  }

  // --- Authorization -------------------------------------------------------------------------

  /**
   * OWNER/SUPERVISOR branches mirror BookingService.requireBookingManagementAccess exactly
   * (never duplicated formula, re-derived scoping only). STAFF is new: an active STAFF
   * membership of THIS business, re-derived from the actor's own identity — never a
   * client-supplied id, matching AuthService.resolveMeBusiness's own "resolve business from the
   * actor's own StaffMembership" convention.
   */
  private async resolveScope(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
  ): Promise<ResolvedScope> {
    if (!Types.ObjectId.isValid(businessId)) {
      throw new DashboardOverviewError("DASHBOARD_OVERVIEW_BUSINESS_NOT_FOUND", 404);
    }

    const business = await this.businessRepository.findById(businessId);
    if (!business) {
      throw new DashboardOverviewError("DASHBOARD_OVERVIEW_BUSINESS_NOT_FOUND", 404);
    }

    if (actorRole === "BUSINESS_OWNER") {
      if (!business.ownerUserId.equals(actorUserId)) {
        throw new DashboardOverviewError("DASHBOARD_OVERVIEW_BUSINESS_NOT_FOUND", 404);
      }
      return { kind: "FULL", business };
    }

    if (actorRole === "SUPERVISOR") {
      const membership = await this.staffRepository.findActiveByUserId(actorUserId);
      if (membership?.role !== "SUPERVISOR" || !membership.businessId.equals(business._id)) {
        throw new DashboardOverviewError("DASHBOARD_OVERVIEW_BUSINESS_NOT_FOUND", 404);
      }
      return { kind: "FULL", business };
    }

    if (actorRole === "STAFF") {
      const membership = await this.staffRepository.findActiveByUserId(actorUserId);
      if (membership?.role !== "STAFF" || !membership.businessId.equals(business._id)) {
        throw new DashboardOverviewError("DASHBOARD_OVERVIEW_BUSINESS_NOT_FOUND", 404);
      }
      return { kind: "STAFF", business, staffMembershipId: membership._id };
    }

    throw new DashboardOverviewError("DASHBOARD_OVERVIEW_BUSINESS_NOT_FOUND", 404);
  }

  // --- FULL-scope financials -------------------------------------------------------------------

  private async buildFinancials(
    business: BusinessDocument,
    todayDateStr: string,
    todaysBookings: BookingDocument[],
  ): Promise<DashboardOverviewFinancials> {
    const monthStartStr = `${todayDateStr.slice(0, 7)}-01`;
    const monthStart = businessLocalToUtc(business.timezone, monthStartStr, "00:00");
    const monthEnd = businessLocalToUtc(
      business.timezone,
      addCalendarMonths(monthStartStr, 1),
      "00:00",
    );

    const [noShowMonthCount, noShowBuckets, monthlyRevenueCents, recentTransactions] =
      await Promise.all([
        this.bookingRepository.countNoShowsForBusinessInRange(business._id, monthStart, monthEnd),
        this.financialTransactionService.aggregateForBusiness({
          businessId: business._id,
          types: ["NO_SHOW_FEE"],
          from: monthStart,
          to: monthEnd,
        }),
        this.financeService.getNetPayoutForBusiness(String(business._id), {
          from: monthStart,
          to: monthEnd,
        }),
        this.financialTransactionService.listRecentForBusiness(business._id, RECENT_ACTIVITY_LIMIT),
      ]);

    const noShowMonthChargedCents =
      noShowBuckets.find((bucket) => bucket.type === "NO_SHOW_FEE" && bucket.status === "SUCCEEDED")
        ?.totalCents ?? 0;

    const payAtVenueDueCents = todaysBookings
      .filter((booking) => booking.status === "UPCOMING" || booking.status === "PENDING")
      .reduce((sum, booking) => sum + booking.financials.balanceDueCents, 0);

    const recentActivity = await this.buildRecentActivity(business._id, recentTransactions);

    return {
      payAtVenueDueCents,
      noShowMonthCount,
      noShowMonthChargedCents,
      monthlyRevenueCents,
      recentActivity,
    };
  }

  private async buildRecentActivity(
    businessId: Types.ObjectId,
    rows: BookingFinancialTransactionDocument[],
  ): Promise<DashboardOverviewActivityEntry[]> {
    const bookingIds = [...new Set(rows.map((row) => String(row.bookingId)))];
    const bookings = await this.bookingRepository.findManyByIds(businessId, bookingIds);
    const bookingById = new Map(bookings.map((booking) => [String(booking._id), booking]));

    return rows.map((entry) => {
      const booking = bookingById.get(String(entry.bookingId));
      return {
        id: String(entry._id),
        type: entry.type,
        status: entry.status,
        amountCents: entry.amountCents,
        currency: entry.currency,
        customerName: booking ? this.fullName(booking) : "Unknown customer",
        serviceName: booking?.serviceLines[0]?.serviceSnapshot.name,
        bookingReference: booking?.reference,
        createdAt: entry.createdAt,
      };
    });
  }

  // --- Row builders --------------------------------------------------------------------------

  private toScheduleRow(booking: BookingDocument, timezone: string): DashboardOverviewScheduleRow {
    const firstLine = booking.serviceLines[0];
    const staffName = firstLine?.staffSnapshot
      ? [firstLine.staffSnapshot.firstName, firstLine.staffSnapshot.lastName]
          .filter(Boolean)
          .join(" ")
      : "—";

    return {
      bookingId: String(booking._id),
      bookingReference: booking.reference,
      time: utcToBusinessLocalTime(timezone, booking.schedule.startAt),
      status: booking.status,
      customerName: this.fullName(booking),
      serviceName: firstLine?.serviceSnapshot.name ?? "—",
      totalPaymentCents: booking.financials.totalCents,
      platformFeeCents: booking.financials.platformFeeCents,
      remainingFeeCents: booking.financials.balanceDueCents,
      staffName,
      leadType: this.leadType(booking),
    };
  }

  private toTimelineEntry(
    booking: BookingDocument,
    timezone: string,
  ): DashboardOverviewTimelineEntry {
    const firstLine = booking.serviceLines[0];
    const durationMin = booking.serviceLines.reduce(
      (sum, line) => sum + line.serviceSnapshot.durationMin,
      0,
    );

    return {
      bookingId: String(booking._id),
      time: utcToBusinessLocalTime(timezone, booking.schedule.startAt),
      customerName: this.fullName(booking),
      detail: firstLine?.serviceSnapshot.name ?? "—",
      durationMin,
    };
  }

  /** Same MANUAL/New/Returning classification BookingRepository.aggregateClientTypeSplit already
   * uses (and `lib/bookings/format.ts`'s `bookingClientBadge` on the frontend) — reused, not
   * re-invented. */
  private leadType(booking: BookingDocument): DashboardOverviewLeadType {
    if (booking.source === "MANUAL") {
      return "MANUAL";
    }
    return booking.financials.platformFeeCents > 0 ? "NEW_CUSTOMER" : "RETURNING";
  }

  private fullName(booking: BookingDocument): string {
    return [booking.customer.contact.firstName, booking.customer.contact.lastName]
      .filter(Boolean)
      .join(" ");
  }
}
