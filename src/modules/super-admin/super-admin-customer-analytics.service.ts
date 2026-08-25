import type { BookingRepository } from "../booking/booking.repository.js";
import type { UserRepository } from "../user/user.repository.js";
import { resolveAnalyticsPeriod } from "./super-admin-analytics.util.js";

export type SuperAdminCustomerAnalyticsDto = {
  period: { from: string; to: string };
  registeredOverTime: Array<{ year: number; month: number; count: number }>;
  registeredTotal: number;
  /** Platform Users (role=CUSTOMER) who have EVER had a real booking with a linked account —
   * deliberately all-time (see BookingRepository.aggregateCustomerActivity's own doc comment on
   * why "has this Customer ever booked" cannot be period-bounded without changing its meaning).
   * This is a GLOBAL, User-level concept — distinct from BusinessClient.activatedAt, which is
   * scoped to one Business's own relationship with that person (rule: "do not globally classify
   * a Customer as returning merely because they booked another Business"). */
  activatedCount: number;
  retainedCount: number;
  dormantCount: number;
};

/** Batch 12 — Super Admin Customer Analytics. */
export class SuperAdminCustomerAnalyticsService {
  public constructor(
    private readonly userRepository: UserRepository,
    private readonly bookingRepository: BookingRepository,
  ) {}

  public async getAnalytics(query: {
    fromDate?: Date | undefined;
    toDate?: Date | undefined;
  }): Promise<SuperAdminCustomerAnalyticsDto> {
    const { from, to } = resolveAnalyticsPeriod(query);

    const [registeredOverTime, registeredTotal, activity] = await Promise.all([
      this.userRepository.countCreatedByMonth("CUSTOMER", from, to),
      this.userRepository.countByRole("CUSTOMER"),
      this.bookingRepository.aggregateCustomerActivity(),
    ]);

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      registeredOverTime,
      registeredTotal,
      activatedCount: activity.activatedCount,
      retainedCount: activity.retainedCount,
      dormantCount: Math.max(0, registeredTotal - activity.activatedCount),
    };
  }
}
