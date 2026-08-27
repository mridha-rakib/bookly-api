import { z } from "zod";

export const integrationBusinessParamsSchema = z
  .object({
    businessId: z.string().regex(/^[a-f\d]{24}$/i, "Invalid business id"),
  })
  .strict();

export const googleCalendarCallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1),
  error: z.string().optional(),
});

export type IntegrationBusinessParams = z.infer<typeof integrationBusinessParamsSchema>;
export type GoogleCalendarCallbackQuery = z.infer<typeof googleCalendarCallbackQuerySchema>;
