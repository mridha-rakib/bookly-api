export const googleCalendarIntegrationStatuses = ["CONNECTED", "ERROR"] as const;

export type GoogleCalendarIntegrationStatus = (typeof googleCalendarIntegrationStatuses)[number];
