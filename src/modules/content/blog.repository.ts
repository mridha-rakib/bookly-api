import type { Types } from "mongoose";

import { type BlogPostDocument, BlogPostModel } from "./blog.model.js";
import type { BlogCategory, BlogStatus } from "./content.types.js";

export type CreateBlogPostInput = {
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
};

export type UpdateBlogPostFields = Partial<
  Pick<
    BlogPostDocument,
    | "title"
    | "slug"
    | "excerpt"
    | "bodyHtml"
    | "category"
    | "status"
    | "publishedAt"
    | "coverMediaId"
    | "galleryMediaIds"
    | "facebookUrl"
    | "instagramUrl"
  >
>;

type AdminListFilter = { category?: BlogCategory | undefined; status?: BlogStatus | undefined };
type PublicListFilter = { category?: BlogCategory | undefined };
type Pagination = { page: number; limit: number };

export class BlogPostRepository {
  public async create(input: CreateBlogPostInput): Promise<BlogPostDocument> {
    return new BlogPostModel(input).save();
  }

  public async findById(postId: Types.ObjectId | string): Promise<BlogPostDocument | null> {
    return BlogPostModel.findById(postId).exec();
  }

  public async findBySlug(slug: string): Promise<BlogPostDocument | null> {
    return BlogPostModel.findOne({ slug }).exec();
  }

  public async findPublishedBySlug(slug: string): Promise<BlogPostDocument | null> {
    return BlogPostModel.findOne({ slug, status: "PUBLISHED" }).exec();
  }

  /** All slugs matching `base` or `base-<n>` — used to pick the next free suffix. */
  public async findSlugsLike(base: string): Promise<string[]> {
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rows = await BlogPostModel.find({ slug: new RegExp(`^${escaped}(?:-\\d+)?$`) })
      .select("slug")
      .exec();
    return rows.map((row) => row.slug);
  }

  public async update(
    postId: Types.ObjectId | string,
    fields: UpdateBlogPostFields,
  ): Promise<BlogPostDocument | null> {
    return BlogPostModel.findByIdAndUpdate(
      postId,
      { $set: fields },
      { returnDocument: "after", runValidators: true },
    ).exec();
  }

  public async delete(postId: Types.ObjectId | string): Promise<void> {
    await BlogPostModel.deleteOne({ _id: postId }).exec();
  }

  public async listForAdmin(
    filter: AdminListFilter,
    pagination: Pagination,
  ): Promise<{ posts: BlogPostDocument[]; total: number }> {
    const query: Record<string, unknown> = {};
    if (filter.category) query["category"] = filter.category;
    if (filter.status) query["status"] = filter.status;

    const skip = (pagination.page - 1) * pagination.limit;
    const [posts, total] = await Promise.all([
      BlogPostModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(pagination.limit).exec(),
      BlogPostModel.countDocuments(query).exec(),
    ]);
    return { posts, total };
  }

  public async listPublished(
    filter: PublicListFilter,
    pagination: Pagination,
  ): Promise<{ posts: BlogPostDocument[]; total: number }> {
    const query: Record<string, unknown> = { status: "PUBLISHED" };
    if (filter.category) query["category"] = filter.category;

    const skip = (pagination.page - 1) * pagination.limit;
    const [posts, total] = await Promise.all([
      BlogPostModel.find(query)
        .sort({ publishedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(pagination.limit)
        .exec(),
      BlogPostModel.countDocuments(query).exec(),
    ]);
    return { posts, total };
  }
}
