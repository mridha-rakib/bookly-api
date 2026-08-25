import type { BusinessRepository } from "../business/business.repository.js";

export type SuperAdminCityCoverageRow = {
  city: string;
  premisesCount: number;
  mobileCount: number;
  approvedCount: number;
};

export type SuperAdminCityCoverageDto = {
  cities: SuperAdminCityCoverageRow[];
};

/** Batch 12 — City Coverage, deferred in Batch 11 pending confirmation that Business.address.city
 * is reliable enough to aggregate on. Confirmed real: `city` is enum-validated against the fixed
 * `businessCities` list at the registration entry point (auth.schema.ts), so grouping by its raw
 * value on the Business document is safe. All-time, current-state — not a period metric. */
export class SuperAdminCityAnalyticsService {
  public constructor(private readonly businessRepository: BusinessRepository) {}

  public async getCityCoverage(): Promise<SuperAdminCityCoverageDto> {
    const cities = await this.businessRepository.aggregateCityCoverage();
    return { cities };
  }
}
