import { z } from "zod";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

/** Cross-business "My Packages" detail — matches bookingIdOnlyParamsSchema's own shape
 * (booking.schema.ts): no businessId in the URL, scoped by customerUserId server-side. */
export const packageProgressIdOnlyParamsSchema = z
  .object({ packageProgressId: objectIdSchema })
  .strict();

/** Business-scoped redemption params (`/:businessId/bookings/packages/:packageProgressId/...`). */
export const packageProgressBusinessParamsSchema = z
  .object({ businessId: objectIdSchema, packageProgressId: objectIdSchema })
  .strict();

export type PackageProgressIdOnlyParams = z.infer<typeof packageProgressIdOnlyParamsSchema>;
export type PackageProgressBusinessParams = z.infer<typeof packageProgressBusinessParamsSchema>;
