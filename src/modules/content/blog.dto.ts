import type { StorageService } from "../storage/storage.service.js";
import type { BlogPostDocument } from "./blog.model.js";
import type { BlogMediaDocument } from "./blog-media.model.js";
import type { BlogCategory, BlogStatus } from "./content.types.js";

/** A single resolved image — fresh URL minted per response, never persisted. */
export type BlogImageDto = {
  id: string;
  url: string;
  mimeType: string;
  size: number;
  originalFileName?: string | undefined;
  createdAt: string;
};

/** Full admin shape — everything the Content Manager needs to list, edit and privately preview
 * (including DRAFT). `createdByUserId` is intentionally absent. */
export type BlogAdminDto = {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  bodyHtml: string;
  category: BlogCategory;
  status: BlogStatus;
  publishedAt: string | null;
  coverMediaId: string | null;
  coverImage: BlogImageDto | null;
  galleryMediaIds: string[];
  galleryImages: BlogImageDto[];
  galleryCount: number;
  facebookUrl?: string | undefined;
  instagramUrl?: string | undefined;
  createdAt: string;
  updatedAt: string;
};

/** Public list card — no bodyHtml, no draft-only fields, no author, no internal ids. */
export type BlogPublicListItemDto = {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  category: BlogCategory;
  publishedAt: string;
  coverImageUrl: string | null;
};

/** Public article detail — render-safe. `bodyHtml` is already sanitized at write time. */
export type BlogPublicDetailDto = {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  bodyHtml: string;
  category: BlogCategory;
  publishedAt: string;
  coverImageUrl: string | null;
  galleryImageUrls: string[];
  facebookUrl?: string | undefined;
  instagramUrl?: string | undefined;
};

export const toBlogMediaDto = async (
  media: BlogMediaDocument,
  storage: StorageService,
): Promise<BlogImageDto> => ({
  id: String(media._id),
  url: await storage.getObjectUrl({ key: media.storageKey }),
  mimeType: media.mimeType,
  size: media.size,
  originalFileName: media.originalFileName,
  createdAt: media.createdAt.toISOString(),
});

/** Resolves a post's cover + gallery media in ONE batched lookup (never N+1), then mints a
 * fresh signed URL per image. `mediaById` is the caller-supplied batch map. */
const resolveImages = async (
  post: BlogPostDocument,
  mediaById: Map<string, BlogMediaDocument>,
  storage: StorageService,
): Promise<{ cover: BlogImageDto | null; gallery: BlogImageDto[] }> => {
  const coverDoc = post.coverMediaId ? mediaById.get(String(post.coverMediaId)) : undefined;
  const cover = coverDoc ? await toBlogMediaDto(coverDoc, storage) : null;

  const gallery: BlogImageDto[] = [];
  for (const id of post.galleryMediaIds) {
    const doc = mediaById.get(String(id));
    if (doc) gallery.push(await toBlogMediaDto(doc, storage));
  }
  return { cover, gallery };
};

export const toBlogAdminDto = async (
  post: BlogPostDocument,
  mediaById: Map<string, BlogMediaDocument>,
  storage: StorageService,
): Promise<BlogAdminDto> => {
  const { cover, gallery } = await resolveImages(post, mediaById, storage);
  return {
    id: String(post._id),
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    bodyHtml: post.bodyHtml,
    category: post.category,
    status: post.status,
    publishedAt: post.publishedAt ? post.publishedAt.toISOString() : null,
    coverMediaId: post.coverMediaId ? String(post.coverMediaId) : null,
    coverImage: cover,
    galleryMediaIds: post.galleryMediaIds.map((id) => String(id)),
    galleryImages: gallery,
    galleryCount: gallery.length,
    facebookUrl: post.facebookUrl,
    instagramUrl: post.instagramUrl,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
};

export const toBlogPublicListItemDto = async (
  post: BlogPostDocument,
  mediaById: Map<string, BlogMediaDocument>,
  storage: StorageService,
): Promise<BlogPublicListItemDto> => {
  const coverDoc = post.coverMediaId ? mediaById.get(String(post.coverMediaId)) : undefined;
  return {
    id: String(post._id),
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    category: post.category,
    // A PUBLISHED post always has publishedAt (set on the transition); createdAt is a defensive
    // fallback for any legacy row and keeps the field non-null for the public contract.
    publishedAt: (post.publishedAt ?? post.createdAt).toISOString(),
    coverImageUrl: coverDoc ? await storage.getObjectUrl({ key: coverDoc.storageKey }) : null,
  };
};

export const toBlogPublicDetailDto = async (
  post: BlogPostDocument,
  mediaById: Map<string, BlogMediaDocument>,
  storage: StorageService,
): Promise<BlogPublicDetailDto> => {
  const { cover, gallery } = await resolveImages(post, mediaById, storage);
  return {
    id: String(post._id),
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    bodyHtml: post.bodyHtml,
    category: post.category,
    publishedAt: (post.publishedAt ?? post.createdAt).toISOString(),
    coverImageUrl: cover ? cover.url : null,
    galleryImageUrls: gallery.map((image) => image.url),
    facebookUrl: post.facebookUrl,
    instagramUrl: post.instagramUrl,
  };
};

/** Collects every media id referenced by a set of posts — for the single batched media lookup. */
export const collectMediaIds = (posts: BlogPostDocument[]): string[] => {
  const ids = new Set<string>();
  for (const post of posts) {
    if (post.coverMediaId) ids.add(String(post.coverMediaId));
    for (const id of post.galleryMediaIds) ids.add(String(id));
  }
  return [...ids];
};
