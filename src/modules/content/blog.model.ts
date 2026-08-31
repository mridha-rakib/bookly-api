import { model, Schema, type Types } from "mongoose";

import {
  BLOG_BODY_HTML_MAX_LENGTH,
  BLOG_EXCERPT_MAX_LENGTH,
  BLOG_SLUG_MAX_LENGTH,
  BLOG_TITLE_MAX_LENGTH,
  type BlogCategory,
  type BlogStatus,
  blogCategories,
  blogStatuses,
} from "./content.types.js";

/**
 * The one BlogPost collection — single source of truth for the Super Admin CMS AND the public
 * blog. `bodyHtml` is stored already-sanitized (blog.sanitize.ts). `slug` is unique and stable
 * after publish unless explicitly edited. `publishedAt` is set on the first transition to
 * PUBLISHED and RETAINED (never cleared) when a post is moved back to DRAFT — kept for audit /
 * history; visibility is governed by `status`, not by `publishedAt`.
 *
 * `coverMediaId` / `galleryMediaIds` reference `BlogMedia` rows; the media objects themselves
 * live in S3. `createdByUserId` is internal — never exposed by any public DTO.
 */
export type BlogPostDocument = {
  _id: Types.ObjectId;
  title: string;
  slug: string;
  excerpt: string;
  bodyHtml: string;
  category: BlogCategory;
  status: BlogStatus;
  publishedAt: Date | null;
  coverMediaId?: Types.ObjectId | undefined;
  galleryMediaIds: Types.ObjectId[];
  facebookUrl?: string | undefined;
  instagramUrl?: string | undefined;
  createdByUserId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

const blogPostSchema = new Schema<BlogPostDocument>(
  {
    title: { type: String, required: true, trim: true, maxlength: BLOG_TITLE_MAX_LENGTH },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: BLOG_SLUG_MAX_LENGTH,
    },
    excerpt: { type: String, required: true, trim: true, maxlength: BLOG_EXCERPT_MAX_LENGTH },
    bodyHtml: { type: String, required: true, maxlength: BLOG_BODY_HTML_MAX_LENGTH },
    category: { type: String, enum: blogCategories, required: true },
    status: { type: String, enum: blogStatuses, required: true, default: "DRAFT" },
    publishedAt: { type: Date, default: null },
    coverMediaId: { type: Schema.Types.ObjectId, ref: "BlogMedia" },
    galleryMediaIds: {
      type: [Schema.Types.ObjectId],
      ref: "BlogMedia",
      required: true,
      default: [],
    },
    facebookUrl: { type: String, trim: true },
    instagramUrl: { type: String, trim: true },
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

// Slug is the public detail key — must be globally unique.
blogPostSchema.index({ slug: 1 }, { unique: true });
// Public list: PUBLISHED newest-first, and the same with a category narrow.
blogPostSchema.index({ status: 1, publishedAt: -1 });
blogPostSchema.index({ status: 1, category: 1, publishedAt: -1 });
// Admin list: newest-created first, optionally narrowed by category/status.
blogPostSchema.index({ createdAt: -1 });
blogPostSchema.index({ category: 1, status: 1, createdAt: -1 });

export const BlogPostModel = model<BlogPostDocument>("BlogPost", blogPostSchema);
