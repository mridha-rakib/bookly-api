import { z } from "zod";

import {
  FAQ_ANSWER_MAX_LENGTH,
  FAQ_QUESTION_MAX_LENGTH,
  FAQ_REORDER_MAX_IDS,
  faqAudiences,
  faqStatuses,
} from "./content.types.js";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const faqIdParamsSchema = z.object({ faqId: objectIdSchema }).strict();

/** Public read — `audience` is REQUIRED (there is no "all audiences" public feed). */
export const publicListFaqsQuerySchema = z.object({ audience: z.enum(faqAudiences) }).strict();

/** Admin read — `audience` required, `status` an optional server-side filter (no client-side
 * array filtering of mock data). */
export const listAdminFaqsQuerySchema = z
  .object({
    audience: z.enum(faqAudiences),
    status: z.enum(faqStatuses).optional(),
  })
  .strict();

export const createFaqBodySchema = z
  .object({
    question: z.string().trim().min(1).max(FAQ_QUESTION_MAX_LENGTH),
    answer: z.string().trim().min(1).max(FAQ_ANSWER_MAX_LENGTH),
    audience: z.enum(faqAudiences),
    status: z.enum(faqStatuses).default("PUBLISHED"),
  })
  .strict();

export const updateFaqBodySchema = z
  .object({
    question: z.string().trim().min(1).max(FAQ_QUESTION_MAX_LENGTH).optional(),
    answer: z.string().trim().min(1).max(FAQ_ANSWER_MAX_LENGTH).optional(),
    status: z.enum(faqStatuses).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export const reorderFaqsBodySchema = z
  .object({
    audience: z.enum(faqAudiences),
    orderedIds: z.array(objectIdSchema).min(1).max(FAQ_REORDER_MAX_IDS),
  })
  .strict()
  .refine((value) => new Set(value.orderedIds).size === value.orderedIds.length, {
    message: "orderedIds must not contain duplicates",
    path: ["orderedIds"],
  });

export type FaqIdParams = z.infer<typeof faqIdParamsSchema>;
export type PublicListFaqsQuery = z.infer<typeof publicListFaqsQuerySchema>;
export type ListAdminFaqsQuery = z.infer<typeof listAdminFaqsQuerySchema>;
export type CreateFaqBody = z.infer<typeof createFaqBodySchema>;
export type UpdateFaqBody = z.infer<typeof updateFaqBodySchema>;
export type ReorderFaqsBody = z.infer<typeof reorderFaqsBodySchema>;
