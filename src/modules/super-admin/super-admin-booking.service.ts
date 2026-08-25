import type { BookingDetailDto, BookingListItemDto } from "../booking/booking.dto.js";
import { toBookingDetailDto, toBookingListItemDto } from "../booking/booking.dto.js";
import { BookingError } from "../booking/booking.errors.js";
import type { BookingRepository } from "../booking/booking.repository.js";
import type { BookingStatus } from "../booking/booking.types.js";
import type { BusinessRepository } from "../business/business.repository.js";

export type SuperAdminBookingListItemDto = BookingListItemDto & { businessName: string };

/** The Super Admin Bookings tab's own 4-bucket UI grouping — the SAME status groupings as
 * lib/bookings/format.ts's CUSTOMER_BOOKING_TAB_STATUSES on the frontend (one canonical mapping
 * from the real 9-value BookingStatus enum, never a screen-specific vocabulary). */
export type SuperAdminBookingTabCounts = {
  all: number;
  upcoming: number;
  completed: number;
  cancelled: number;
  noShow: number;
};

/** Batch 11 — the explicit, cross-business Super Admin Bookings read surface. Reuses
 * `BookingRepository.listForSuperAdmin`/`findByIdOnly` and the EXACT SAME `toBookingListItemDto`/
 * `toBookingDetailDto` mapping every other Booking surface uses — never a second DTO shape,
 * never a Business-scoped endpoint with its own authorization bypassed. The only Super-Admin-
 * specific addition is `businessName`, batched in (never N+1) since a cross-business list
 * spans many different Businesses per page and the Booking document itself has no business name
 * snapshot. */
export class SuperAdminBookingService {
  public constructor(
    private readonly bookingRepository: BookingRepository,
    private readonly businessRepository: BusinessRepository,
  ) {}

  public async list(
    filter: {
      businessId?: string | undefined;
      status?: BookingStatus[] | undefined;
      q?: string | undefined;
      fromDate?: Date | undefined;
      toDate?: Date | undefined;
    },
    pagination: { page: number; limit: number },
  ): Promise<{
    bookings: SuperAdminBookingListItemDto[];
    pagination: { page: number; limit: number; total: number };
    counts: SuperAdminBookingTabCounts;
  }> {
    const [{ bookings, total }, statusCounts] = await Promise.all([
      this.bookingRepository.listForSuperAdmin(filter, pagination),
      this.bookingRepository.countAllByStatus(),
    ]);

    const businessIds = [...new Set(bookings.map((b) => String(b.businessId)))];
    const businesses = await this.businessRepository.findManyByIds(businessIds);
    const businessNameById = new Map(businesses.map((b) => [String(b._id), b.name]));

    return {
      bookings: bookings.map((booking) => ({
        ...toBookingListItemDto(booking),
        businessName: businessNameById.get(String(booking.businessId)) ?? "—",
      })),
      pagination: { page: pagination.page, limit: pagination.limit, total },
      counts: {
        all: Object.values(statusCounts).reduce((sum, count) => sum + count, 0),
        upcoming: statusCounts.UPCOMING + statusCounts.PENDING,
        completed: statusCounts.COMPLETED,
        cancelled:
          statusCounts.CANCELLED_BY_CUSTOMER +
          statusCounts.CANCELLED_BY_BUSINESS +
          statusCounts.LATE_CANCELLATION,
        noShow:
          statusCounts.NO_SHOW_CHARGED +
          statusCounts.NO_SHOW_WAIVED +
          statusCounts.NO_SHOW_CANCELLED,
      },
    };
  }

  public async getDetail(bookingId: string): Promise<BookingDetailDto> {
    const booking = await this.bookingRepository.findByIdOnly(bookingId);
    if (!booking) {
      throw new BookingError("BOOKING_NOT_FOUND", 404);
    }
    return toBookingDetailDto(booking);
  }
}
