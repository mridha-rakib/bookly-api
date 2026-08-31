import { BLOG_SLUG_MAX_LENGTH } from "./content.types.js";

const COMBINING_DIACRITICS = /[̀-ͯ]/g;
const NON_SLUG_CHARS = /[^a-z0-9]+/g;
const EDGE_HYPHENS = /^-+|-+$/g;
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Derives a URL-safe slug from arbitrary text (usually the post title). Lowercase ASCII,
 * diacritics stripped, every run of non-alphanumerics collapsed to a single hyphen, trimmed,
 * length-capped. Falls back to "post" for input that reduces to nothing.
 *
 * Uniqueness is NOT handled here — see BlogService.resolveUniqueSlug, which appends `-2`, `-3`, …
 * against the DB and relies on the `{ slug: 1 } unique` index as the final guard.
 */
export const slugify = (input: string): string => {
  const base = input
    .normalize("NFKD")
    .replace(COMBINING_DIACRITICS, "")
    .toLowerCase()
    .replace(NON_SLUG_CHARS, "-")
    .replace(EDGE_HYPHENS, "")
    .slice(0, BLOG_SLUG_MAX_LENGTH)
    .replace(EDGE_HYPHENS, "");

  return base.length > 0 ? base : "post";
};

/** True when `value` is already a well-formed slug (what `slugify` would produce, unchanged). */
export const isValidSlug = (value: string): boolean =>
  value.length > 0 && value.length <= BLOG_SLUG_MAX_LENGTH && SLUG_SHAPE.test(value);
