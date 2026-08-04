export const businessStatuses = ["PENDING", "APPROVED", "WARNING", "SUSPENDED"] as const;

export type BusinessStatus = (typeof businessStatuses)[number];

export const businessVisitTypes = ["location", "travel"] as const;

export type BusinessVisitType = (typeof businessVisitTypes)[number];
