import { z } from "zod";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const dashboardOverviewParamsSchema = z.object({ businessId: objectIdSchema }).strict();
export const dashboardOverviewQuerySchema = z
  .object({
    range: z.enum(["Today", "7D", "30D", "Custom"]).default("Today"),
    fromDate: z.string().date().optional(),
    toDate: z.string().date().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.range === "Custom" &&
      (!value.fromDate ||
        !value.toDate ||
        value.fromDate > value.toDate ||
        Date.parse(value.toDate) - Date.parse(value.fromDate) > 365 * 86400000)
    )
      ctx.addIssue({ code: "custom", message: "Choose an ordered date range of at most 366 days" });
  });
export type DashboardOverviewQuery = z.infer<typeof dashboardOverviewQuerySchema>;

export type DashboardOverviewParams = z.infer<typeof dashboardOverviewParamsSchema>;
