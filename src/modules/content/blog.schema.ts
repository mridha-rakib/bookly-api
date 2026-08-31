import { z } from "zod";
import { isValidSlug } from "./blog.slug.js";
import {
  BLOG_BODY_HTML_MAX_LENGTH,
  BLOG_EXCERPT_MAX_LENGTH,
  BLOG_GALLERY_MAX,
  BLOG_SLUG_MAX_LENGTH,
  BLOG_TITLE_MAX_LENGTH,
  blogCategories,
  blogStatuses,
} from "./content.types.js";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

const slugFieldSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(BLOG_SLUG_MAX_LENGTH)
  .refine(isValidSlug, "Slug must be lowercase words separated by single hyphens");

const socialUrlSchema = z.string().trim().url().max(500);

const paginationQuerySchema = z.object({
  page: z.string().regex(/^\d+$/, "Invalid page").optional(),
  limit: z.string().regex(/^\d+$/, "Invalid limit").optional(),
});

export const blogPostIdParamsSchema = z.object({ postId: objectIdSchema }).strict();
export const blogMediaIdParamsSchema = z.object({ mediaId: objectIdSchema }).strict();
export const blogSlugParamsSchema = z
  .object({ slug: z.string().trim().min(1).max(BLOG_SLUG_MAX_LENGTH) })
  .strict();

export const listAdminBlogQuerySchema = paginationQuerySchema
  .extend({
    category: z.enum(blogCategories).optional(),
    status: z.enum(blogStatuses).optional(),
  })
  .strict()
  .transform((value) => ({
    category: value.category,
    status: value.status,
    page: value.page ? Math.max(1, Number(value.page)) : 1,
    limit: value.limit ? Math.min(50, Math.max(1, Number(value.limit))) : 20,
  }));

export const listPublicBlogQuerySchema = paginationQuerySchema
  .extend({ category: z.enum(blogCategories).optional() })
  .strict()
  .transform((value) => ({
    category: value.category,
    page: value.page ? Math.max(1, Number(value.page)) : 1,
    limit: value.limit ? Math.min(50, Math.max(1, Number(value.limit))) : 12,
  }));

export const createBlogBodySchema = z
  .object({
    title: z.string().trim().min(1).max(BLOG_TITLE_MAX_LENGTH),
    slug: slugFieldSchema.optional(),
    excerpt: z.string().trim().min(1).max(BLOG_EXCERPT_MAX_LENGTH).optional(),
    bodyHtml: z.string().min(1).max(BLOG_BODY_HTML_MAX_LENGTH),
    category: z.enum(blogCategories),
    status: z.enum(blogStatuses).default("DRAFT"),
    coverMediaId: objectIdSchema.optional(),
    galleryMediaIds: z.array(objectIdSchema).max(BLOG_GALLERY_MAX).default([]),
    facebookUrl: socialUrlSchema.optional(),
    instagramUrl: socialUrlSchema.optional(),
  })
  .strict();

export const updateBlogBodySchema = z
  .object({
    title: z.string().trim().min(1).max(BLOG_TITLE_MAX_LENGTH).optional(),
    slug: slugFieldSchema.optional(),
    excerpt: z.string().trim().min(1).max(BLOG_EXCERPT_MAX_LENGTH).optional(),
    bodyHtml: z.string().min(1).max(BLOG_BODY_HTML_MAX_LENGTH).optional(),
    category: z.enum(blogCategories).optional(),
    status: z.enum(blogStatuses).optional(),
    coverMediaId: objectIdSchema.nullable().optional(),
    galleryMediaIds: z.array(objectIdSchema).max(BLOG_GALLERY_MAX).optional(),
    facebookUrl: socialUrlSchema.nullable().optional(),
    instagramUrl: socialUrlSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export type ListAdminBlogQuery = z.infer<typeof listAdminBlogQuerySchema>;
export type ListPublicBlogQuery = z.infer<typeof listPublicBlogQuerySchema>;
export type BlogPostIdParams = z.infer<typeof blogPostIdParamsSchema>;
export type BlogMediaIdParams = z.infer<typeof blogMediaIdParamsSchema>;
export type BlogSlugParams = z.infer<typeof blogSlugParamsSchema>;
export type CreateBlogBody = z.infer<typeof createBlogBodySchema>;
export type UpdateBlogBody = z.infer<typeof updateBlogBodySchema>;
