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

/** Current-state Business coverage using the same trimmed registered-city authority as the
 * reporting selector. Empty cities remain an unassigned bucket; no Business is discarded. */
export class SuperAdminCityAnalyticsService {
  public constructor(private readonly businessRepository: BusinessRepository) {}

  public async getCityCoverage(): Promise<SuperAdminCityCoverageDto> {
    const cities = await this.businessRepository.aggregateCityCoverage();
    return { cities };
  }
}
