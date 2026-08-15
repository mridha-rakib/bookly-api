/**
 * Canonical values backing the existing Add Staff form's two leave-type options ("Annual
 * Holiday", "Sick leave"). No additional leave types are introduced — the confirmed rule
 * says to preserve exactly these two.
 */
export const staffTimeOffTypes = ["ANNUAL_HOLIDAY", "SICK_LEAVE"] as const;

export type StaffTimeOffType = (typeof staffTimeOffTypes)[number];

export const staffTimeOffTypeLabels: Record<StaffTimeOffType, string> = {
  ANNUAL_HOLIDAY: "Annual Holiday",
  SICK_LEAVE: "Sick leave",
};
