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

// --- P4B-2C ordinary Booking Calendar sync status and Owner recovery -------------------------

const objectId = z.string().regex(/^[a-f\d]{24}$/, "Invalid id");

export const bookingCalendarSyncParamsSchema = z
  .object({ businessId: objectId, bookingId: objectId })
  .strict();

/** Strict: an Owner/actor id, a destination, a generation or a "force" flag can never be posted.
 * The actor is the authenticated session; the destination is the Business's current connection. */
export const bookingCalendarRecoveryBodySchema = z
  .object({
    incidentReference: z.string().trim().min(1).max(200),
    assertion: z.enum(["ALL_ISSUERS_QUIESCED_AND_PROVIDER_SETTLED", "NO_UNRESOLVED_REQUEST"]),
    requestId: z.uuid().optional(),
    rebindToCurrentConnection: z.boolean().optional(),
    bindUnusedDestination: z.boolean().optional(),
  })
  .strict()
  .refine((body) => !(body.rebindToCurrentConnection && body.bindUnusedDestination), {
    message: "Choose one destination decision",
  })
  .refine(
    (body) =>
      (body.assertion === "ALL_ISSUERS_QUIESCED_AND_PROVIDER_SETTLED") === Boolean(body.requestId),
    {
      message: "An unresolved request id must be named exactly when its settlement is attested",
    },
  );

export type BookingCalendarSyncParams = z.infer<typeof bookingCalendarSyncParamsSchema>;
export type BookingCalendarRecoveryBody = z.infer<typeof bookingCalendarRecoveryBodySchema>;
