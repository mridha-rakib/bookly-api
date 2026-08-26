import { z } from "zod";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const dashboardAnalyticsParamsSchema = z.object({ businessId: objectIdSchema }).strict();

const periodEnum = z.enum(["MONTH", "YEAR", "ALL"]);

export const dashboardAnalyticsQuerySchema = z
  .object({ period: periodEnum.optional() })
  .strict()
  .transform((value) => ({ period: value.period ?? "MONTH" }));

export type DashboardAnalyticsParams = z.infer<typeof dashboardAnalyticsParamsSchema>;
export type DashboardAnalyticsQuery = z.infer<typeof dashboardAnalyticsQuerySchema>;
