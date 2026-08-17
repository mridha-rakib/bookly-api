import { z } from "zod";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

/** Params for GET /:businessId/services/:serviceId/addons (Service Edit's Assigned Add-ons). */
export const addonServiceIdParamsSchema = z
  .object({ businessId: objectIdSchema, serviceId: objectIdSchema })
  .strict();

export type AddonServiceIdParams = z.infer<typeof addonServiceIdParamsSchema>;
