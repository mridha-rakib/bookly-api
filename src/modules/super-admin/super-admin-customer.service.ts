import type { BookingListItemDto } from "../booking/booking.dto.js";
import { toBookingListItemDto } from "../booking/booking.dto.js";
import type { BookingRepository } from "../booking/booking.repository.js";
import { bookingPaymentSummary } from "../booking/booking-payment-summary.js";
import type { UserDocument, UserProfileDocument } from "../user/user.model.js";
import type { UserRepository } from "../user/user.repository.js";
import type { UserStatus } from "../user/user.types.js";
import { resolveNotificationPreferences } from "../user/user.types.js";
import { SuperAdminError } from "./super-admin.errors.js";
import { SuperAdminCustomerRepository } from "./super-admin-customer.repository.js";

export type SuperAdminCustomerListItemDto = {
  id: string;
  email: string;
  status: UserStatus;
  firstName?: string;
  lastName?: string;
  phone?: { countryCode: string; nationalNumber: string; e164: string };
  createdAt: string;
  businessCount: number;
  hasSavedCard: boolean;
  savedCard: { brand: string; last4: string } | null;
  marketingConsent: boolean;
  avatarUrl?: string;
  address?: string;
};

export type SuperAdminCustomerDetailDto = SuperAdminCustomerListItemDto & {
  /** Server-paginated canonical Bookings. FIRST/RETURNING belongs to each Business relationship. */
  bookings: CustomerHistoryItem[];
  bookingsTotal: number;
  bookingPagination: { page: number; limit: number; total: number };
  statistics: { total: number; completed: number; noShows: number; upcoming: number };
  relationships: Awaited<
    ReturnType<SuperAdminCustomerRepository["listRelationships"]>
  >["relationships"];
  relationshipPagination: { page: number; limit: number; total: number };
};

export type CustomerHistoryItem = BookingListItemDto & {
  businessName: string;
  actualOnlinePaidCents: number;
};
export const customerCsvRow = (values: unknown[]) =>
  values
    .map((value) => {
      let text = String(value ?? "");
      // Spreadsheet formulas can be hidden behind whitespace/control characters.
      const formulaText = [...text]
        .filter((character) => character.charCodeAt(0) >= 32)
        .join("")
        .trimStart();
      if (/^[=+@-]/u.test(formulaText) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    })
    .join(",");

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
    private readonly customerRepository = new SuperAdminCustomerRepository(),
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
    const summaries = await this.customerRepository.summaries(users.map((u) => u._id));

    return {
      customers: users.map((user) => ({
        ...this.toListItemDto(user, profileByUserId.get(String(user._id))),
        ...summaries.get(String(user._id)),
      })),
      pagination: { page: pagination.page, limit: pagination.limit, total },
    };
  }

  public async getDetail(
    userId: string,
    pagination = { page: 1, limit: 20, relationshipsPage: 1 },
  ): Promise<SuperAdminCustomerDetailDto> {
    const user = await this.userRepository.findById(userId);
    if (user?.role !== "CUSTOMER") {
      throw new SuperAdminError("SUPER_ADMIN_CUSTOMER_NOT_FOUND", 404);
    }

    const [profile, history, summaries, statistics, relationships] = await Promise.all([
      this.userRepository.findProfileByUserId(userId),
      this.bookingHistory(userId, pagination),
      this.customerRepository.summaries([user._id]),
      this.customerRepository.statistics(userId),
      this.customerRepository.listRelationships(userId, pagination.relationshipsPage, 20),
    ]);

    return {
      ...this.toListItemDto(user, profile ?? undefined),
      ...summaries.get(String(user._id)),
      bookings: history.bookings,
      bookingsTotal: history.pagination.total,
      bookingPagination: history.pagination,
      statistics,
      relationships: relationships.relationships,
      relationshipPagination: relationships.pagination,
    };
  }

  private async bookingHistory(userId: string, pagination: { page: number; limit: number }) {
    const { bookings, total } = await this.bookingRepository.listForCustomer(
      userId,
      {},
      { page: pagination.page, limit: pagination.limit },
    );
    const names = await this.customerRepository.businessNames(
      bookings.map((booking) => String(booking.businessId)),
    );
    return {
      bookings: bookings.map((booking) => ({
        ...toBookingListItemDto(booking),
        businessName: names.get(String(booking.businessId)) ?? "Unavailable business",
        actualOnlinePaidCents: bookingPaymentSummary(booking).actualOnlinePaidCents,
      })),
      pagination: { ...pagination, total },
    };
  }

  public async exportCustomers(filter: {
    status?: UserStatus | undefined;
    q?: string | undefined;
  }) {
    const rows = [
      customerCsvRow([
        "Customer ID",
        "Name",
        "Email",
        "Phone",
        "Registered (UTC)",
        "Businesses",
        "Saved card",
        "Marketing consent",
        "Status",
      ]),
    ];
    for (let page = 1; ; page++) {
      const result = await this.list(filter, { page, limit: 100 });
      for (const customer of result.customers)
        rows.push(
          customerCsvRow([
            customer.id,
            [customer.firstName, customer.lastName].filter(Boolean).join(" "),
            customer.email,
            customer.phone?.e164,
            customer.createdAt,
            customer.businessCount,
            customer.hasSavedCard,
            customer.marketingConsent,
            customer.status,
          ]),
        );
      if (page * 100 >= result.pagination.total || !result.customers.length) break;
    }
    return { csv: rows.join("\r\n"), filename: "bookly-customers.csv" };
  }

  public async exportBookings(userId: string) {
    const user = await this.userRepository.findById(userId);
    if (user?.role !== "CUSTOMER") throw new SuperAdminError("SUPER_ADMIN_CUSTOMER_NOT_FOUND", 404);
    const rows = [
      customerCsvRow([
        "Booking ID",
        "Reference",
        "Start (UTC)",
        "Business timezone",
        "Business",
        "Service",
        "Amount",
        "Online paid",
        "Currency",
        "Status",
      ]),
    ];
    for (let page = 1; ; page++) {
      const result = await this.bookingHistory(userId, { page, limit: 100 });
      for (const booking of result.bookings)
        rows.push(
          customerCsvRow([
            booking.id,
            booking.reference,
            booking.schedule.startAt,
            booking.schedule.timezone,
            booking.businessName,
            booking.primaryServiceName,
            (booking.totalCents / 100).toFixed(2),
            (booking.actualOnlinePaidCents / 100).toFixed(2),
            booking.currency,
            booking.status,
          ]),
        );
      if (page * 100 >= result.pagination.total || !result.bookings.length) break;
    }
    return { csv: rows.join("\r\n"), filename: `bookly-customer-${userId}-bookings.csv` };
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
      businessCount: 0,
      hasSavedCard: false,
      savedCard: null,
      marketingConsent: resolveNotificationPreferences(profile?.notifications).marketingEmail,
    };
  }
}
