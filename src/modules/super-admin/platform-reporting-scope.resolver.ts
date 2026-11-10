import { AppError } from "../../common/errors/app-error.js";
import {
  isoDayOfWeekFor,
  type PlatformReportingScope,
  type ReportingDay,
} from "../../common/reporting/platform-reporting-scope.js";
import type { BusinessRepository } from "../business/business.repository.js";

export type ResolvedReportingScope = {
  scope: PlatformReportingScope | undefined;
  /** Echoed back so the client can label results truthfully. */
  filters: { city: string | null; day: ReportingDay | null };
};

/** P2.2.4 — turns the validated `city`/`day` query values into a repository scope. City options
 * come from the real Business data (distinct trimmed registered cities); a city that no Business
 * is registered in is rejected rather than silently returning zeros. */
export class PlatformReportingScopeResolver {
  public constructor(
    private readonly businessRepository: Pick<
      BusinessRepository,
      "listRegisteredCities" | "findIdsByRegisteredCity"
    >,
  ) {}

  public listCities(): Promise<string[]> {
    return this.businessRepository.listRegisteredCities();
  }

  public async resolve(query: {
    city?: string | undefined;
    day?: ReportingDay | undefined;
  }): Promise<ResolvedReportingScope> {
    const filters = { city: query.city ?? null, day: query.day ?? null };
    if (!query.city && !query.day) return { scope: undefined, filters };

    const scope: PlatformReportingScope = {};
    if (query.city) {
      const cities = await this.businessRepository.listRegisteredCities();
      if (!cities.includes(query.city)) {
        throw new AppError("Unknown city", 400, {
          details: [{ message: "Choose a city from the list", code: "REPORTING_CITY_UNKNOWN" }],
        });
      }
      scope.businessIds = await this.businessRepository.findIdsByRegisteredCity(query.city);
    }
    if (query.day) scope.isoDayOfWeek = isoDayOfWeekFor(query.day);
    return { scope, filters };
  }
}
