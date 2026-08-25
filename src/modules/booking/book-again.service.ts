import type { BusinessRepository } from "../business/business.repository.js";
import { businessStatuses } from "../business/business.types.js";
import type { BusinessMediaRepository } from "../business-media/business-media.repository.js";
import type { StorageService } from "../storage/storage.service.js";
import type { BookAgainCandidateDto, BookAgainListResult } from "./book-again.dto.js";
import type { BookingListPagination, BookingRepository } from "./booking.repository.js";

// Same visibility semantics as everywhere else a Customer-facing surface decides what counts as
// a real, currently-bookable Business (matches discovery.repository.ts's own constant).
const PUBLICLY_VISIBLE_STATUSES = new Set<string>(
  businessStatuses.filter((s) => s === "APPROVED" || s === "WARNING"),
);

/**
 * Batch 16 — Book Again's real read model. Reuses `BookingRepository.listForCustomer` (the SAME
 * primitive My Bookings already uses — no parallel query engine) filtered to
 * `status: ["COMPLETED"], source: ["BOOKLY_MANAGED"]` (the exact analogue of Batch 14's own
 * confirmed Review-eligibility rule: a genuinely fulfilled, Bookly-managed visit — a Business
 * Owner's MANUAL entry was never something the Customer themselves booked, and no other status
 * represents a completed visit).
 *
 * This module intentionally does NOT create a new booking — see booking-creation.service.ts's
 * `finalizeCustomerBooking`, the one real entry point the frontend calls when the Customer
 * actually clicks through and confirms a repeat booking (going through the exact same wizard,
 * fresh pricing/availability/staff-eligibility/promo/first-returning checks, every time).
 */
export class BookAgainService {
  public constructor(
    private readonly bookingRepository: BookingRepository,
    private readonly businessRepository: BusinessRepository,
    private readonly businessMediaRepository: BusinessMediaRepository,
    private readonly storageService?: Pick<StorageService, "getObjectUrl">,
  ) {}

  public async listCandidates(
    customerUserId: string,
    pagination: BookingListPagination,
  ): Promise<BookAgainListResult> {
    const { bookings, total } = await this.bookingRepository.listForCustomer(
      customerUserId,
      { status: ["COMPLETED"], source: ["BOOKLY_MANAGED"] },
      pagination,
    );

    const businessIds = [...new Set(bookings.map((b) => String(b.businessId)))];
    const [businesses, profileMedia] = await Promise.all([
      this.businessRepository.findManyByIds(businessIds),
      this.businessMediaRepository.listProfileByBusinessIds(businessIds),
    ]);
    const businessById = new Map(businesses.map((b) => [String(b._id), b]));
    const imageUrlByBusinessId = new Map(
      await Promise.all(
        profileMedia.map(async (media) => {
          const url =
            (await this.storageService?.getObjectUrl({ key: media.storageKey })) ?? undefined;
          return [String(media.businessId), url] as const;
        }),
      ),
    );

    const candidates: BookAgainCandidateDto[] = bookings
      .map((booking): BookAgainCandidateDto | null => {
        const business = businessById.get(String(booking.businessId));
        // Excluded rather than shown as a dead end (confirmed via the same visibility rule as
        // Discovery/catalog) — a PENDING Business never was public, a SUSPENDED one no longer is.
        if (!business || !PUBLICLY_VISIBLE_STATUSES.has(business.status)) {
          return null;
        }
        const primaryLine = booking.serviceLines[0];
        if (!primaryLine) {
          return null;
        }
        return {
          originalBookingId: String(booking._id),
          originalReference: booking.reference,
          businessId: String(booking.businessId),
          businessName: business.name,
          businessImageUrl: imageUrlByBusinessId.get(String(booking.businessId)),
          primaryServiceName: primaryLine.serviceSnapshot.name,
          serviceId: String(primaryLine.serviceId),
          staffMembershipId: primaryLine.responsibleStaffMembershipId
            ? String(primaryLine.responsibleStaffMembershipId)
            : undefined,
          originalStartAt: booking.schedule.startAt.toISOString(),
          originalTotalCents: booking.financials.totalCents,
          currency: booking.financials.currency,
        };
      })
      .filter((candidate): candidate is BookAgainCandidateDto => candidate !== null);

    return {
      candidates,
      pagination: { page: pagination.page, limit: pagination.limit, total },
    };
  }
}
