import { Types } from "mongoose";
import type { AddonRepository } from "../addons/addon.repository.js";
import type { AddonServiceAssignmentRepository } from "../addons/addon-service-assignment.repository.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import { normalizeBusinessVisitType } from "../business/business.types.js";
import type { BusinessClientDocument } from "../client/client.model.js";
import type { ClientRepository } from "../client/client.repository.js";
import type { ServiceDocument } from "../services/service.model.js";
import type { ServiceRepository } from "../services/service.repository.js";
import type { StaffMembershipDocument } from "../staff/staff.model.js";
import type { StaffRepository } from "../staff/staff.repository.js";
import type { UserRole } from "../user/user.types.js";
import { BookingError } from "./booking.errors.js";
import type {
  BookingDocument,
  BookingFinancials,
  BookingFulfilment,
  BookingServiceLineAddon,
} from "./booking.model.js";
import type {
  BookingListFilter,
  BookingListPagination,
  BookingListResult,
  BookingRepository,
} from "./booking.repository.js";
import {
  type BookingSource,
  DEPOSIT_MAX_CENTS,
  DEPOSIT_MIN_CENTS,
  DEPOSIT_PERCENT,
  MAX_BOOKING_RANGE_DAYS,
} from "./booking.types.js";

const oneDayMs = 24 * 60 * 60 * 1000;

/**
 * Booking domain — Phase 1 scope only.
 *
 * This service intentionally does NOT expose a "create a Booking" orchestration method yet.
 * Creating a real Booking requires availability/conflict enforcement (Phase 2) to run first —
 * otherwise a persisted Booking (Manual or Bookly-managed) could silently double-book a Staff
 * member, which the confirmed product rules explicitly forbid building around. What IS
 * implemented here are the individually-testable validation building blocks Phase 2/3's actual
 * creation flow will compose: authorization, Staff-eligibility, Client cross-business
 * rejection, Add-on snapshot resolution, and the pure Bookly platform-fee calculator. Each is
 * exercised directly in tests (see booking.service.test.ts / booking-database.integration.test.ts)
 * without going through any HTTP route, since none exists in this phase — see booking.route
 * absence, documented in the Phase 0/1 report.
 *
 * Planned (not yet built) PackageProgress relationship (confirmed rule K): a small
 * Business+Customer+Service-scoped record tracking { totalSessions, completedSessions,
 * remainingSessions } plus a list of { sessionIndex, bookingId } once a session has actually
 * been scheduled. BookingServiceLine.pricingInput.packageProgressId (booking.model.ts) already
 * reserves the reference so introducing that collection later never requires reshaping Booking.
 */
export class BookingService {
  public constructor(
    private readonly businessRepository: BusinessRepository,
    private readonly staffRepository: StaffRepository,
    private readonly serviceRepository: ServiceRepository,
    private readonly addonRepository: AddonRepository,
    private readonly addonServiceAssignmentRepository: AddonServiceAssignmentRepository,
    private readonly clientRepository: ClientRepository,
    private readonly bookingRepository: BookingRepository,
  ) {}

  // --- Authorization foundation -----------------------------------------------------------

  /**
   * Owner-or-active-Supervisor Business-scoping for future Booking management routes —
   * mirrors ClientService.requireBusinessAccess exactly (the only existing Supervisor-scoped
   * precedent in this codebase). BusinessAccess (linked/secondary Business) is deliberately
   * never consulted — a linked Business grants no booking-management rights (confirmed rule
   * V). STAFF and CUSTOMER both fall through to the same 404 as an unrelated user — Staff has
   * no new booking-management permission in this phase (confirmed rule W), and a Customer's
   * own booking operations are a separate, not-yet-built authorization surface (they act on
   * their own Bookings, never as a Business-scoped manager). 404 (never a bare 403) on every
   * mismatch, matching the anti-enumeration convention Client/Service/Staff already use.
   */
  public async requireBookingManagementAccess(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
  ): Promise<BusinessDocument> {
    if (!Types.ObjectId.isValid(businessId)) {
      throw new BookingError("BOOKING_BUSINESS_NOT_FOUND", 404);
    }

    const business = await this.businessRepository.findById(businessId);

    if (!business) {
      throw new BookingError("BOOKING_BUSINESS_NOT_FOUND", 404);
    }

    if (actorRole === "BUSINESS_OWNER") {
      if (!business.ownerUserId.equals(actorUserId)) {
        throw new BookingError("BOOKING_BUSINESS_NOT_FOUND", 404);
      }
      return business;
    }

    if (actorRole === "SUPERVISOR") {
      const membership = await this.staffRepository.findActiveByUserId(actorUserId);

      if (membership?.role !== "SUPERVISOR" || !membership.businessId.equals(business._id)) {
        throw new BookingError("BOOKING_BUSINESS_NOT_FOUND", 404);
      }
      return business;
    }

    throw new BookingError("BOOKING_BUSINESS_NOT_FOUND", 404);
  }

  // --- Domain validation building blocks ---------------------------------------------------

  /**
   * Validates that a responsible provider for a Booking Service line is real: a Service
   * belonging to this Business, not archived; a StaffMembership belonging to this Business,
   * not soft-removed, currently employmentActive, and assigned to that Service. The Business
   * Owner can never satisfy this — Owner has no StaffMembership row at all (see
   * staff.model.ts), so any attempt to pass the Owner's userId or a synthesized/owner-only
   * identifier simply fails STAFF_NOT_FOUND like any other unknown id (confirmed rule A/G,
   * enforced structurally, not by a special-cased "is this the Owner" check — see the
   * defensive role check below for why that's still asserted explicitly too).
   */
  public async validateResponsibleStaff(
    business: BusinessDocument,
    serviceId: string,
    staffMembershipId: string,
  ): Promise<{ service: ServiceDocument; staffMembership: StaffMembershipDocument }> {
    if (!Types.ObjectId.isValid(serviceId)) {
      throw new BookingError("BOOKING_SERVICE_NOT_FOUND", 404);
    }

    const service = await this.serviceRepository.findById(business._id, serviceId);

    if (!service) {
      throw new BookingError("BOOKING_SERVICE_NOT_FOUND", 404);
    }

    if (service.status === "ARCHIVED") {
      throw new BookingError("BOOKING_SERVICE_ARCHIVED", 409);
    }

    if (!Types.ObjectId.isValid(staffMembershipId)) {
      throw new BookingError("BOOKING_STAFF_NOT_FOUND", 404);
    }

    const staffMembership = await this.staffRepository.findActiveById(
      business._id,
      staffMembershipId,
    );

    if (!staffMembership) {
      throw new BookingError("BOOKING_STAFF_NOT_FOUND", 404);
    }

    // Defense in depth: StaffMembership.role is already typed to exclude "BUSINESS_OWNER" (see
    // staff.types.ts staffCreatableRoles) and the Owner never has a membership row at all, so
    // this branch should be unreachable — asserted explicitly anyway because "the Owner is
    // never an eligible provider" is a confirmed product rule, not an incidental side effect
    // of an unrelated type definition.
    if (staffMembership.role !== "SUPERVISOR" && staffMembership.role !== "STAFF") {
      throw new BookingError("BOOKING_STAFF_NOT_ELIGIBLE", 409);
    }

    if (!staffMembership.employmentActive) {
      throw new BookingError("BOOKING_STAFF_NOT_ELIGIBLE", 409);
    }

    const isAssignedToService = service.assignedStaffMembershipIds.some((id) =>
      id.equals(staffMembership._id),
    );

    if (!isAssignedToService) {
      throw new BookingError("BOOKING_STAFF_NOT_ELIGIBLE", 409);
    }

    return { service, staffMembership };
  }

  /**
   * Resolves the actual Customer/Client context for a Booking (confirmed rule D). A
   * businessClientId scoped to a different Business than the one being booked resolves to
   * null (ClientRepository.findById already scopes by businessId) and is rejected here exactly
   * like an unknown id — cross-Business Client references are never distinguishable from
   * "not found", by design (anti-enumeration, matching every other module's convention).
   */
  public async validateCustomerReference(
    business: BusinessDocument,
    businessClientId: string,
  ): Promise<BusinessClientDocument> {
    if (!Types.ObjectId.isValid(businessClientId)) {
      throw new BookingError("BOOKING_CLIENT_NOT_FOUND", 404);
    }

    const client = await this.clientRepository.findById(business._id, businessClientId);

    if (!client) {
      throw new BookingError("BOOKING_CLIENT_NOT_FOUND", 404);
    }

    return client;
  }

  /**
   * Snapshots the selected Add-ons for one Service line (confirmed rule H/J): every requested
   * Add-on must belong to this Business and be assigned to the given Service. Two batched
   * queries regardless of how many Add-ons are requested (matches the Services/Add-ons
   * modules' batched-lookup convention — never one query per Add-on).
   */
  public async resolveAddonSnapshots(
    business: BusinessDocument,
    serviceId: string,
    addonIds: string[],
  ): Promise<BookingServiceLineAddon[]> {
    if (addonIds.length === 0) {
      return [];
    }

    const uniqueIds = [...new Set(addonIds)];

    for (const id of uniqueIds) {
      if (!Types.ObjectId.isValid(id)) {
        throw new BookingError("BOOKING_ADDON_NOT_FOUND", 404);
      }
    }

    const [addons, assignments] = await Promise.all([
      this.addonRepository.findManyByIdsForBusiness(business._id, uniqueIds),
      this.addonServiceAssignmentRepository.findByServiceIds([serviceId]),
    ]);

    const addonById = new Map(addons.map((addon) => [String(addon._id), addon]));
    const assignedAddonIds = new Set(assignments.map((assignment) => String(assignment.addonId)));

    return uniqueIds.map((id) => {
      const addon = addonById.get(id);

      if (!addon) {
        throw new BookingError("BOOKING_ADDON_NOT_FOUND", 404);
      }

      if (!assignedAddonIds.has(id)) {
        throw new BookingError("BOOKING_ADDON_NOT_ASSIGNED_TO_SERVICE", 400);
      }

      return { addonId: addon._id, name: addon.name, priceCents: addon.priceCents ?? 0 };
    });
  }

  /**
   * Validates that a Booking's fulfilment snapshot is internally consistent with the Business
   * it belongs to (confirmed rule L): a Business uses exactly one fulfilment mode, so the
   * Booking's own `fulfilment.mode` must match Business.visitType, and exactly the matching
   * location snapshot (business location XOR travel address) must be present — never both,
   * never neither. Address selection and travel-fee calculation themselves are explicitly not
   * implemented in this phase; this only guards the snapshot's internal shape.
   */
  public validateFulfilmentSnapshot(
    business: BusinessDocument,
    fulfilment: BookingFulfilment,
  ): void {
    const expectedMode = normalizeBusinessVisitType(business.visitType);

    if (fulfilment.mode !== expectedMode) {
      throw new BookingError("BOOKING_FULFILMENT_MODE_MISMATCH", 409);
    }

    if (expectedMode === "AT_BUSINESS_LOCATION") {
      if (!fulfilment.businessLocation || fulfilment.travelAddress) {
        throw new BookingError("BOOKING_FULFILMENT_SNAPSHOT_INVALID", 400);
      }
      return;
    }

    if (!fulfilment.travelAddress || fulfilment.businessLocation) {
      throw new BookingError("BOOKING_FULFILMENT_SNAPSHOT_INVALID", 400);
    }
  }

  /**
   * Enforces confirmed rule E: a MANUAL Booking is financially outside Bookly entirely — no
   * platform fee, no Bookly deposit, ever. BOOKLY_MANAGED Bookings are not constrained here
   * (their actual fee/deposit values are Phase 2/3 payment work).
   */
  public validateManualBookingHasNoBooklyFee(
    source: BookingSource,
    financials: Pick<BookingFinancials, "platformFeeCents" | "depositCents">,
  ): void {
    if (
      source === "MANUAL" &&
      (financials.platformFeeCents !== 0 || financials.depositCents !== 0)
    ) {
      throw new BookingError("BOOKING_MANUAL_FEE_NOT_ZERO", 409);
    }
  }

  // --- Range-safety foundation (item 11) ---------------------------------------------------

  /**
   * Domain-level guard on any Business date-range Booking read (the future Calendar/All
   * Bookings query) — never a UX-layer concern. Rejects an inverted or missing range and
   * anything wider than MAX_BOOKING_RANGE_DAYS, so an unbounded query (accidental or
   * malicious) can never reach BookingRepository.findManyByBusinessIdInRange, which does not
   * itself enforce this (a repository is data access only — see that method's own comment).
   */
  public requireBoundedRange(startAt: Date, endAt: Date): void {
    if (startAt >= endAt) {
      throw new BookingError("BOOKING_RANGE_INVALID", 400);
    }

    const rangeMs = endAt.getTime() - startAt.getTime();
    if (rangeMs > MAX_BOOKING_RANGE_DAYS * oneDayMs) {
      throw new BookingError("BOOKING_RANGE_TOO_WIDE", 400, [
        {
          message: `The date range must not exceed ${MAX_BOOKING_RANGE_DAYS} days`,
          code: "BOOKING_RANGE_TOO_WIDE",
        },
      ]);
    }
  }

  /**
   * The validated entry point for the future Calendar/All Bookings read — always range-
   * checked first. `excludeHistory` is on by default here because this is a *list* read (see
   * BookingRepository.findManyByBusinessIdInRange's own comment on why eventHistory/
   * rescheduleHistory are dropped for list views); a single Booking's detail read is a
   * separate, not-yet-built code path that would want the full document.
   */
  public async findBookingsInRange(
    business: BusinessDocument,
    startAt: Date,
    endAt: Date,
    options: { excludeHistory?: boolean } = { excludeHistory: true },
  ): Promise<BookingDocument[]> {
    this.requireBoundedRange(startAt, endAt);
    return this.bookingRepository.findManyByBusinessIdInRange(
      business._id,
      startAt,
      endAt,
      options,
    );
  }

  // --- Batch 3: detail / list / calendar reads --------------------------------------------

  public async getBookingDetailForBusiness(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    bookingId: string,
  ): Promise<BookingDocument> {
    const business = await this.requireBookingManagementAccess(actorUserId, actorRole, businessId);

    if (!Types.ObjectId.isValid(bookingId)) {
      throw new BookingError("BOOKING_NOT_FOUND", 404);
    }
    const booking = await this.bookingRepository.findById(business._id, bookingId);
    if (!booking) {
      throw new BookingError("BOOKING_NOT_FOUND", 404);
    }
    return booking;
  }

  /** Ownership is enforced entirely at the query level (both `_id` and `customer.customerUserId`
   * in the same filter) — matches this codebase's anti-enumeration convention: a foreign
   * Customer's bookingId is indistinguishable from an unknown one. */
  public async getBookingDetailForCustomer(
    customerUserId: string,
    bookingId: string,
  ): Promise<BookingDocument> {
    if (!Types.ObjectId.isValid(bookingId)) {
      throw new BookingError("BOOKING_NOT_FOUND", 404);
    }
    const booking = await this.bookingRepository.findByIdForCustomer(bookingId, customerUserId);
    if (!booking) {
      throw new BookingError("BOOKING_NOT_FOUND", 404);
    }
    return booking;
  }

  public async listBookingsForBusiness(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    filter: BookingListFilter,
    pagination: BookingListPagination,
  ): Promise<BookingListResult> {
    const business = await this.requireBookingManagementAccess(actorUserId, actorRole, businessId);
    return this.bookingRepository.listForBusiness(business._id, filter, pagination);
  }

  public async listBookingsForCustomer(
    customerUserId: string,
    filter: Omit<BookingListFilter, "businessClientId">,
    pagination: BookingListPagination,
  ): Promise<BookingListResult> {
    return this.bookingRepository.listForCustomer(customerUserId, filter, pagination);
  }

  public async getCalendarForBusiness(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    startAt: Date,
    endAt: Date,
  ): Promise<BookingDocument[]> {
    const business = await this.requireBookingManagementAccess(actorUserId, actorRole, businessId);
    this.requireBoundedRange(startAt, endAt);
    return this.bookingRepository.findManyForCalendar(business._id, startAt, endAt);
  }

  // --- Pure calculators ---------------------------------------------------------------------

  /**
   * Batch 6.5 correction — THE single canonical booking-deposit calculator: clamp(20% of
   * `eligibleAmountCents`, €5, €35). `eligibleAmountCents` must already exclude travel fee —
   * that separation happens where the basis is assembled, never here.
   *
   * Previously named `calculatePlatformFeeCents`, back when this codebase (incorrectly)
   * assumed the upfront deposit and Bookly's platform fee were always the same concept. They
   * are related but distinct: this function computes ONLY the deposit — the amount charged
   * online for EVERY BOOKLY_MANAGED booking, first or returning. Whether Bookly keeps that
   * deposit as platform/activation revenue or the Business keeps it as an already-collected
   * service prepayment is decided entirely by the caller
   * (booking-creation.service.ts's assembleFinancials: `platformFeeCents = isFirstBooking ?
   * depositCents : 0`) — never re-derived here. Renamed rather than duplicated so there is
   * still exactly ONE place this formula is computed (see the module's own callers — small
   * blast radius, confirmed by inspection before renaming).
   *
   * A pure function with no payment side effect.
   */
  public calculateBookingDepositCents(eligibleAmountCents: number): number {
    if (!Number.isInteger(eligibleAmountCents) || eligibleAmountCents < 0) {
      throw new BookingError("BOOKING_INVALID_DEPOSIT_BASIS", 400);
    }

    const rawDepositCents = Math.round(eligibleAmountCents * DEPOSIT_PERCENT);
    return Math.min(Math.max(rawDepositCents, DEPOSIT_MIN_CENTS), DEPOSIT_MAX_CENTS);
  }
}
