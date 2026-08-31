import { STATIC_PAGE_DEFAULTS, type StaticPageKey } from "./content.types.js";
import type { StaticPageDocument } from "./static-page.model.js";

/**
 * Admin shape — always returns all four known pages. `exists: false` (with an empty `bodyHtml`
 * and the canonical default title) means the page has never been saved yet. No user ids.
 */
export type StaticPageAdminDto = {
  pageKey: StaticPageKey;
  routePath: string;
  title: string;
  bodyHtml: string;
  exists: boolean;
  updatedAt: string | null;
  createdAt: string | null;
};

/** Public shape — real persisted content only. No `createdByUserId` / `updatedByUserId`, no
 * `exists` flag, no internal Mongo metadata. */
export type StaticPagePublicDto = {
  pageKey: StaticPageKey;
  routePath: string;
  title: string;
  bodyHtml: string;
  updatedAt: string;
};

export const toStaticPageAdminDto = (
  pageKey: StaticPageKey,
  doc: StaticPageDocument | null,
): StaticPageAdminDto => {
  const defaults = STATIC_PAGE_DEFAULTS[pageKey];
  if (!doc) {
    return {
      pageKey,
      routePath: defaults.routePath,
      title: defaults.title,
      bodyHtml: "",
      exists: false,
      updatedAt: null,
      createdAt: null,
    };
  }
  return {
    pageKey: doc.pageKey,
    routePath: defaults.routePath,
    title: doc.title,
    bodyHtml: doc.bodyHtml,
    exists: true,
    updatedAt: doc.updatedAt.toISOString(),
    createdAt: doc.createdAt.toISOString(),
  };
};

export const toStaticPagePublicDto = (doc: StaticPageDocument): StaticPagePublicDto => ({
  pageKey: doc.pageKey,
  routePath: STATIC_PAGE_DEFAULTS[doc.pageKey].routePath,
  title: doc.title,
  bodyHtml: doc.bodyHtml,
  updatedAt: doc.updatedAt.toISOString(),
});
