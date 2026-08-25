import type { BookingRepository } from "../booking/booking.repository.js";
import type { BusinessRepository } from "../business/business.repository.js";
import { resolveAnalyticsPeriod } from "./super-admin-analytics.util.js";

export type SuperAdminTopServiceRow = {
  serviceId: string;
  name: string;
  businessId: string;
  businessName: string;
  count: number;
};

export type SuperAdminTopServicesDto = {
  period: { from: string; to: string };
  services: SuperAdminTopServiceRow[];
};

/** Batch 12 — Top Services by booking count, deferred in Batch 11 for lack of a real aggregate.
 * Now real: each Booking's serviceLines snapshot the service's NAME at booking time (see
 * booking.model.ts's own doc comment), so this survives a Service being renamed/archived/deleted
 * without a live join. */
export class SuperAdminServiceAnalyticsService {
  public constructor(
    private readonly bookingRepository: BookingRepository,
    private readonly businessRepository: BusinessRepository,
  ) {}

  public async getTopServices(query: {
    fromDate?: Date | undefined;
    toDate?: Date | undefined;
    limit: number;
  }): Promise<SuperAdminTopServicesDto> {
    const { from, to } = resolveAnalyticsPeriod(query);
    const rows = await this.bookingRepository.aggregateTopServices(from, to, query.limit);

    const businessIds = [...new Set(rows.map((row) => row.businessId))];
    const businesses = await this.businessRepository.findManyByIds(businessIds);
    const businessNameById = new Map(businesses.map((b) => [String(b._id), b.name]));

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      services: rows.map((row) => ({
        ...row,
        businessName: businessNameById.get(row.businessId) ?? "—",
      })),
    };
  }
}
