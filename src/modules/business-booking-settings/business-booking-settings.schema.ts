import { z } from "zod";

import { businessIdParamsSchema } from "../business/business.schema.js";

export { businessIdParamsSchema as businessBookingSettingsParamsSchema };

export const updateBusinessBookingSettingsBodySchema = z
  .object({
    gapEliminationEnabled: z.boolean(),
  })
  .strict();

export type BusinessBookingSettingsParams = z.infer<typeof businessIdParamsSchema>;
export type UpdateBusinessBookingSettingsBody = z.infer<
  typeof updateBusinessBookingSettingsBodySchema
>;
