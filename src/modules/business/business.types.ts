export const businessStatuses = ["PENDING", "APPROVED", "WARNING", "SUSPENDED"] as const;

export type BusinessStatus = (typeof businessStatuses)[number];

export const businessVisitTypes = ["AT_BUSINESS_LOCATION", "TRAVEL_TO_CUSTOMER"] as const;

export type BusinessVisitType = (typeof businessVisitTypes)[number];

export const businessCities = ["Larnaca", "Limassol", "Nicosia", "Paphos"] as const;

export type BusinessCity = (typeof businessCities)[number];

export const businessVisitTypeAliases = ["location", "travel"] as const;

export type BusinessVisitTypeAlias = (typeof businessVisitTypeAliases)[number];

export const normalizeBusinessVisitType = (
  visitType: BusinessVisitType | BusinessVisitTypeAlias,
): BusinessVisitType => {
  if (visitType === "location") {
    return "AT_BUSINESS_LOCATION";
  }

  if (visitType === "travel") {
    return "TRAVEL_TO_CUSTOMER";
  }

  return visitType;
};
