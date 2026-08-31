import { z } from "zod";

import {
  STATIC_PAGE_BODY_HTML_MAX_LENGTH,
  STATIC_PAGE_TITLE_MAX_LENGTH,
  staticPageKeys,
} from "./content.types.js";

export const staticPageKeyParamsSchema = z.object({ pageKey: z.enum(staticPageKeys) }).strict();

export const updateStaticPageBodySchema = z
  .object({
    title: z.string().trim().min(1).max(STATIC_PAGE_TITLE_MAX_LENGTH),
    bodyHtml: z.string().min(1).max(STATIC_PAGE_BODY_HTML_MAX_LENGTH),
  })
  .strict();

export type StaticPageKeyParams = z.infer<typeof staticPageKeyParamsSchema>;
export type UpdateStaticPageBody = z.infer<typeof updateStaticPageBodySchema>;
