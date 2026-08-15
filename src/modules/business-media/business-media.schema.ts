import { z } from "zod";

import { businessIdParamsSchema } from "../business/business.schema.js";

export const mediaIdParamsSchema = businessIdParamsSchema
  .extend({
    mediaId: z.string().regex(/^[a-f\d]{24}$/i, "Invalid media id"),
  })
  .strict();

export type MediaIdParams = z.infer<typeof mediaIdParamsSchema>;
