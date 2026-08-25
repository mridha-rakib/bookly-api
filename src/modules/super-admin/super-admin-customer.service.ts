import type { BookingListItemDto } from "../booking/booking.dto.js";
import { toBookingListItemDto } from "../booking/booking.dto.js";
import type { BookingRepository } from "../booking/booking.repository.js";
import type { UserDocument, UserProfileDocument } from "../user/user.model.js";
import type { UserRepository } from "../user/user.repository.js";
import type { UserStatus } from "../user/user.types.js";
import { SuperAdminError } from "./super-admin.errors.js";

export type SuperAdminCustomerListItemDto = {
  id: string;
  email: string;
  status: UserStatus;
  firstName?: string;
  lastName?: string;
  phone?: { countryCode: string; nationalNumber: string; e164: string };
  createdAt: string;
};

export type SuperAdminCustomerDetailDto = SuperAdminCustomerListItemDto & {
  /** Bounded, most-recent-first — never the customer's full history unbounded. First-vs-
   * returning is intentionally NOT summarized into one global label here: `source` +
   * `platformFeeCents` on each row is the same real, Business-scoped data the existing
   * `bookingClientBadge` frontend helper already renders correctly per row (see Batch 11's own
   * report on why a single global New/Returning badge would misrepresent this domain model). */
  bookings: BookingListItemDto[];
  bookingsTotal: number;
};

/** Batch 11 — the global Customer read surface. A "Customer" here is strictly the platform
 * User/CustomerProfile identity — never a BusinessClient row (a Business's own, per-Business
 * contact record with no platform account) — preserving that distinction is the whole point of
 * this module existing separately from client.service.ts. Reuses
 * `bookingRepository.listForCustomer` (the exact same primitive `/me/bookings` already uses) for
 * booking history — never a second query builder. */
export class SuperAdminCustomerService {
  public constructor(
    private readonly userRepository: UserRepository,
    private readonly bookingRepository: BookingRepository,
  ) {}

  public async list(
    filter: { status?: UserStatus | undefined; q?: string | undefined },
    pagination: { page: number; limit: number },
  ): Promise<{
    customers: SuperAdminCustomerListItemDto[];
    pagination: { page: number; limit: number; total: number };
  }> {
    const { users, total } = await this.userRepository.listByRole("CUSTOMER", filter, pagination);
    const profiles = await this.userRepository.findProfilesByUserIds(users.map((u) => u._id));
    const profileByUserId = new Map(profiles.map((p) => [String(p.userId), p]));

    return {
      customers: users.map((user) =>
        this.toListItemDto(user, profileByUserId.get(String(user._id))),
      ),
      pagination: { page: pagination.page, limit: pagination.limit, total },
    };
  }

  public async getDetail(userId: string): Promise<SuperAdminCustomerDetailDto> {
    const user = await this.userRepository.findById(userId);
    if (user?.role !== "CUSTOMER") {
      throw new SuperAdminError("SUPER_ADMIN_CUSTOMER_NOT_FOUND", 404);
    }

    const [profile, { bookings, total }] = await Promise.all([
      this.userRepository.findProfileByUserId(userId),
      this.bookingRepository.listForCustomer(userId, {}, { page: 1, limit: 50 }),
    ]);

    return {
      ...this.toListItemDto(user, profile ?? undefined),
      bookings: bookings.map(toBookingListItemDto),
      bookingsTotal: total,
    };
  }

  private toListItemDto(
    user: UserDocument,
    profile: UserProfileDocument | undefined,
  ): SuperAdminCustomerListItemDto {
    return {
      id: String(user._id),
      email: user.normalizedEmail,
      status: user.status,
      ...(profile ? { firstName: profile.firstName, lastName: profile.lastName } : {}),
      ...(profile?.phone ? { phone: profile.phone } : {}),
      createdAt: user.createdAt.toISOString(),
    };
  }
}
