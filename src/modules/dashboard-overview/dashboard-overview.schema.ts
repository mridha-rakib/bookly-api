import { z } from "zod";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const dashboardOverviewParamsSchema = z.object({ businessId: objectIdSchema }).strict();

export type DashboardOverviewParams = z.infer<typeof dashboardOverviewParamsSchema>;
