import { randomUUID } from "node:crypto";
import { Types } from "mongoose";

import type { StorageService } from "../storage/storage.service.js";
import {
  type BlogAdminDto,
  type BlogImageDto,
  type BlogPublicDetailDto,
  type BlogPublicListItemDto,
  collectMediaIds,
  toBlogAdminDto,
  toBlogMediaDto,
  toBlogPublicDetailDto,
  toBlogPublicListItemDto,
} from "./blog.dto.js";
import { BlogError } from "./blog.errors.js";
import type { BlogPostDocument } from "./blog.model.js";
import type {
  BlogPostRepository,
  CreateBlogPostInput,
  UpdateBlogPostFields,
} from "./blog.repository.js";
import { htmlToPlainText, sanitizeBlogHtml } from "./blog.sanitize.js";
import { slugify } from "./blog.slug.js";
import type { BlogMediaDocument } from "./blog-media.model.js";
import type { BlogMediaRepository } from "./blog-media.repository.js";
import {
  BLOG_EXCERPT_MAX_LENGTH,
  type BlogCategory,
  type BlogImageMimeType,
  type BlogStatus,
  blogImageMimeTypes,
} from "./content.types.js";

export type BlogUpload = {
  buffer: Buffer;
  mimeType: string;
  size: number;
  originalFileName?: string | undefined;
};

export type CreateBlogRequest = {
  title: string;
  slug?: string | undefined;
  excerpt?: string | undefined;
  bodyHtml: string;
  category: BlogCategory;
  status: BlogStatus;
  coverMediaId?: string | undefined;
  galleryMediaIds: string[];
  facebookUrl?: string | undefined;
  instagramUrl?: string | undefined;
};

export type UpdateBlogRequest = {
  title?: string | undefined;
  slug?: string | undefined;
  excerpt?: string | undefined;
  bodyHtml?: string | undefined;
  category?: BlogCategory | undefined;
  status?: BlogStatus | undefined;
  coverMediaId?: string | null | undefined;
  galleryMediaIds?: string[] | undefined;
  facebookUrl?: string | null | undefined;
  instagramUrl?: string | null | undefined;
};

type Pagination = { page: number; limit: number };

const extensionByMimeType: Record<BlogImageMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * Blog domain service. SUPER_ADMIN-only writers (enforced at the route layer). `listPublished`
 * and `getPublishedBySlug` are the ONLY methods that filter to PUBLISHED — everything else is
 * behind the Super Admin gate and may see DRAFT.
 */
export class BlogService {
  public constructor(
    private readonly blogRepository: BlogPostRepository,
    private readonly blogMediaRepository: BlogMediaRepository,
    private readonly storageService: StorageService,
    private readonly config: { maxUploadBytes: number },
  ) {}

  // --- Admin reads -------------------------------------------------------------------------

  public async listForAdmin(
    filter: { category?: BlogCategory | undefined; status?: BlogStatus | undefined },
    pagination: Pagination,
  ): Promise<{
    posts: BlogAdminDto[];
    pagination: { page: number; limit: number; total: number };
  }> {
    const { posts, total } = await this.blogRepository.listForAdmin(filter, pagination);
    const mediaById = await this.loadMediaMap(posts);
    const dtos = await Promise.all(
      posts.map((post) => toBlogAdminDto(post, mediaById, this.storageService)),
    );
    return {
      posts: dtos,
      pagination: { page: pagination.page, limit: pagination.limit, total },
    };
  }

  public async getByIdForAdmin(postId: string): Promise<BlogAdminDto> {
    const post = await this.requirePost(postId);
    const mediaById = await this.loadMediaMap([post]);
    return toBlogAdminDto(post, mediaById, this.storageService);
  }

  // --- Public reads ----------------------------------------------------------------------

  public async listPublished(
    filter: { category?: BlogCategory | undefined },
    pagination: Pagination,
  ): Promise<{
    posts: BlogPublicListItemDto[];
    pagination: { page: number; limit: number; total: number };
  }> {
    const { posts, total } = await this.blogRepository.listPublished(filter, pagination);
    const mediaById = await this.loadMediaMap(posts);
    const dtos = await Promise.all(
      posts.map((post) => toBlogPublicListItemDto(post, mediaById, this.storageService)),
    );
    return {
      posts: dtos,
      pagination: { page: pagination.page, limit: pagination.limit, total },
    };
  }

  public async getPublishedBySlug(slug: string): Promise<BlogPublicDetailDto> {
    const post = await this.blogRepository.findPublishedBySlug(slug);
    if (!post) {
      throw new BlogError("BLOG_POST_NOT_FOUND", 404);
    }
    const mediaById = await this.loadMediaMap([post]);
    return toBlogPublicDetailDto(post, mediaById, this.storageService);
  }

  // --- Admin writes --------------------------------------------------------------------

  public async create(superAdminUserId: string, request: CreateBlogRequest): Promise<BlogAdminDto> {
    const bodyHtml = sanitizeBlogHtml(request.bodyHtml);
    const slug = await this.resolveUniqueSlug(request.slug ?? request.title);
    await this.assertMediaExists(request.coverMediaId, request.galleryMediaIds);

    const input: CreateBlogPostInput = {
      title: request.title,
      slug,
      excerpt: this.resolveExcerpt(request.excerpt, bodyHtml),
      bodyHtml,
      category: request.category,
      status: request.status,
      publishedAt: request.status === "PUBLISHED" ? new Date() : null,
      coverMediaId: request.coverMediaId ? new Types.ObjectId(request.coverMediaId) : undefined,
      galleryMediaIds: request.galleryMediaIds.map((id) => new Types.ObjectId(id)),
      facebookUrl: request.facebookUrl,
      instagramUrl: request.instagramUrl,
      createdByUserId: new Types.ObjectId(superAdminUserId),
    };

    const created = await this.createWithSlugRetry(input);
    return this.getByIdForAdmin(String(created._id));
  }

  public async update(postId: string, request: UpdateBlogRequest): Promise<BlogAdminDto> {
    const existing = await this.requirePost(postId);
    const fields: UpdateBlogPostFields = {};

    if (request.title !== undefined) fields.title = request.title;

    if (request.slug !== undefined) {
      fields.slug =
        request.slug === existing.slug
          ? existing.slug
          : await this.resolveUniqueSlug(request.slug, existing.slug);
    }

    let nextBodyHtml = existing.bodyHtml;
    if (request.bodyHtml !== undefined) {
      nextBodyHtml = sanitizeBlogHtml(request.bodyHtml);
      fields.bodyHtml = nextBodyHtml;
    }

    if (request.excerpt !== undefined) {
      fields.excerpt = this.resolveExcerpt(request.excerpt, nextBodyHtml);
    } else if (
      request.bodyHtml !== undefined &&
      this.isAutoExcerpt(existing.excerpt, existing.bodyHtml)
    ) {
      // Author never set an explicit excerpt and the body changed — keep it auto-derived.
      fields.excerpt = this.resolveExcerpt(undefined, nextBodyHtml);
    }

    if (request.category !== undefined) fields.category = request.category;

    if (request.status !== undefined) {
      fields.status = request.status;
      // Set publishedAt on the FIRST transition to PUBLISHED; never clear it on unpublish
      // (retained for audit/history — visibility is governed by `status`).
      if (request.status === "PUBLISHED" && existing.publishedAt === null) {
        fields.publishedAt = new Date();
      }
    }

    if (request.coverMediaId !== undefined) {
      fields.coverMediaId = request.coverMediaId
        ? new Types.ObjectId(request.coverMediaId)
        : undefined;
    }
    if (request.galleryMediaIds !== undefined) {
      fields.galleryMediaIds = request.galleryMediaIds.map((id) => new Types.ObjectId(id));
    }
    if (request.facebookUrl !== undefined) fields.facebookUrl = request.facebookUrl ?? undefined;
    if (request.instagramUrl !== undefined) fields.instagramUrl = request.instagramUrl ?? undefined;

    await this.assertMediaExists(
      request.coverMediaId === undefined
        ? existing.coverMediaId
          ? String(existing.coverMediaId)
          : undefined
        : (request.coverMediaId ?? undefined),
      request.galleryMediaIds ?? existing.galleryMediaIds.map((id) => String(id)),
    );

    const updated = await this.blogRepository.update(postId, fields);
    if (!updated) {
      throw new BlogError("BLOG_POST_NOT_FOUND", 404);
    }
    return this.getByIdForAdmin(String(updated._id));
  }

  /**
   * Hard delete (project convention — promo/faq/staff-schedule). Removes the post row, then
   * best-effort deletes its cover + gallery media rows and S3 objects so no orphaned objects
   * remain. Media deletion failures are swallowed (the post is already gone; a stray object is
   * not worth failing the request or resurrecting the post).
   */
  public async delete(postId: string): Promise<{ id: string }> {
    const post = await this.requirePost(postId);
    const mediaIds = [...(post.coverMediaId ? [post.coverMediaId] : []), ...post.galleryMediaIds];

    await this.blogRepository.delete(postId);

    if (mediaIds.length > 0) {
      const mediaDocs = await this.blogMediaRepository.findManyByIds(mediaIds);
      await Promise.allSettled(
        mediaDocs.map((media) => this.storageService.deleteObject({ key: media.storageKey })),
      );
      await this.blogMediaRepository.deleteManyByIds(mediaIds);
    }

    return { id: postId };
  }

  // --- Media --------------------------------------------------------------------------

  public async uploadMedia(
    superAdminUserId: string,
    file: BlogUpload | undefined,
  ): Promise<BlogImageDto> {
    const valid = this.requireValidImage(file);
    const storageKey = `blog/${randomUUID()}.${extensionByMimeType[valid.mimeType]}`;

    await this.storageService.putObject({
      key: storageKey,
      body: valid.buffer,
      contentType: valid.mimeType,
      contentLength: valid.size,
    });

    try {
      const media = await this.blogMediaRepository.create({
        storageKey,
        bucket: this.storageService.bucket,
        mimeType: valid.mimeType,
        size: valid.size,
        originalFileName: valid.originalFileName,
        createdBy: new Types.ObjectId(superAdminUserId),
      });
      return toBlogMediaDto(media, this.storageService);
    } catch (error) {
      await this.storageService.deleteObject({ key: storageKey });
      throw error;
    }
  }

  public async deleteMedia(mediaId: string): Promise<{ id: string }> {
    const media = await this.blogMediaRepository.findById(mediaId);
    if (!media) {
      throw new BlogError("BLOG_MEDIA_NOT_FOUND", 404);
    }
    await this.blogMediaRepository.delete(mediaId);
    try {
      await this.storageService.deleteObject({ key: media.storageKey });
    } catch (error) {
      // Re-create the row so the reference is not silently lost if S3 delete fails.
      await this.blogMediaRepository.create({
        storageKey: media.storageKey,
        bucket: media.bucket,
        mimeType: media.mimeType,
        size: media.size,
        originalFileName: media.originalFileName,
        createdBy: media.createdBy,
      });
      throw error;
    }
    return { id: mediaId };
  }

  // --- Internals --------------------------------------------------------------------

  private async requirePost(postId: string): Promise<BlogPostDocument> {
    if (!Types.ObjectId.isValid(postId)) {
      throw new BlogError("BLOG_POST_NOT_FOUND", 404);
    }
    const post = await this.blogRepository.findById(postId);
    if (!post) {
      throw new BlogError("BLOG_POST_NOT_FOUND", 404);
    }
    return post;
  }

  private resolveExcerpt(explicit: string | undefined, bodyHtml: string): string {
    const trimmed = explicit?.trim();
    if (trimmed) return trimmed.slice(0, BLOG_EXCERPT_MAX_LENGTH);

    const text = htmlToPlainText(bodyHtml);
    if (text.length <= 200) return text || "—";
    return `${text.slice(0, 200).trimEnd()}…`;
  }

  /** Heuristic: does the stored excerpt look auto-generated from the (previous) body? */
  private isAutoExcerpt(excerpt: string, bodyHtml: string): boolean {
    return excerpt === this.resolveExcerpt(undefined, bodyHtml);
  }

  private async resolveUniqueSlug(source: string, currentSlug?: string): Promise<string> {
    const base = slugify(source);
    if (base === currentSlug) return base;

    const taken = new Set(await this.blogRepository.findSlugsLike(base));
    taken.delete(currentSlug ?? "");

    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    // Astronomically unlikely; fall back to a uuid suffix rather than loop forever.
    return `${base}-${randomUUID().slice(0, 8)}`;
  }

  /** The unique index is the real guard against a race between resolveUniqueSlug and save(). */
  private async createWithSlugRetry(input: CreateBlogPostInput): Promise<BlogPostDocument> {
    try {
      return await this.blogRepository.create(input);
    } catch (error) {
      if (this.isDuplicateSlugError(error)) {
        return this.blogRepository.create({
          ...input,
          slug: `${input.slug}-${randomUUID().slice(0, 8)}`,
        });
      }
      throw error;
    }
  }

  private isDuplicateSlugError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: number }).code === 11000
    );
  }

  private async assertMediaExists(
    coverMediaId: string | undefined,
    galleryMediaIds: string[],
  ): Promise<void> {
    const ids = [...(coverMediaId ? [coverMediaId] : []), ...galleryMediaIds];
    if (ids.length === 0) return;
    const unique = [...new Set(ids)];
    const found = await this.blogMediaRepository.findManyByIds(unique);
    if (found.length !== unique.length) {
      throw new BlogError("BLOG_MEDIA_REFERENCE_INVALID", 400);
    }
  }

  private async loadMediaMap(posts: BlogPostDocument[]): Promise<Map<string, BlogMediaDocument>> {
    const ids = collectMediaIds(posts);
    if (ids.length === 0) return new Map();
    const docs = await this.blogMediaRepository.findManyByIds(ids);
    return new Map(docs.map((doc) => [String(doc._id), doc]));
  }

  private requireValidImage(
    file: BlogUpload | undefined,
  ): BlogUpload & { mimeType: BlogImageMimeType } {
    if (!file) {
      throw new BlogError("BLOG_MEDIA_FILE_REQUIRED", 400);
    }
    if (file.size > this.config.maxUploadBytes) {
      throw new BlogError("BLOG_MEDIA_TOO_LARGE", 413);
    }
    if (!this.isAllowedMime(file.mimeType) || !this.bufferMatchesMime(file.buffer, file.mimeType)) {
      throw new BlogError("BLOG_MEDIA_INVALID_TYPE", 400);
    }
    return file as BlogUpload & { mimeType: BlogImageMimeType };
  }

  private isAllowedMime(mimeType: string): mimeType is BlogImageMimeType {
    return blogImageMimeTypes.includes(mimeType as BlogImageMimeType);
  }

  private bufferMatchesMime(buffer: Buffer, mimeType: string): boolean {
    if (mimeType === "image/jpeg") {
      return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    }
    if (mimeType === "image/png") {
      return buffer
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
    if (mimeType === "image/webp") {
      return (
        buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WEBP"
      );
    }
    if (mimeType === "image/gif") {
      const signature = buffer.subarray(0, 6).toString("ascii");
      return signature === "GIF87a" || signature === "GIF89a";
    }
    return false;
  }
}
