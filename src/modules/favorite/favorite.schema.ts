import { z } from "zod";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const favoriteBusinessIdParamsSchema = z.object({ businessId: objectIdSchema }).strict();

export const listFavoritesQuerySchema = z
  .object({
    page: z.string().regex(/^\d+$/, "Invalid page").optional(),
    limit: z.string().regex(/^\d+$/, "Invalid limit").optional(),
  })
  .strict()
  .transform((value) => ({
    page: value.page ? Math.max(1, Number(value.page)) : 1,
    limit: value.limit ? Math.min(50, Math.max(1, Number(value.limit))) : 20,
  }));

export type FavoriteBusinessIdParams = z.infer<typeof favoriteBusinessIdParamsSchema>;
export type ListFavoritesQuery = z.infer<typeof listFavoritesQuerySchema>;
