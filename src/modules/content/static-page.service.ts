import { Types } from "mongoose";

import { sanitizeContentHtml } from "./content.sanitize.js";
import { type StaticPageKey, staticPageKeys } from "./content.types.js";
import {
  type StaticPageAdminDto,
  type StaticPagePublicDto,
  toStaticPageAdminDto,
  toStaticPagePublicDto,
} from "./static-page.dto.js";
import { StaticPageError } from "./static-page.errors.js";
import type { StaticPageRepository } from "./static-page.repository.js";

export type UpdateStaticPageRequest = {
  title: string;
  bodyHtml: string;
};

/**
 * Static Pages domain service. SUPER_ADMIN-only writers (enforced at the route layer). The
 * collection is a fixed set of 4 pages; `listForAdmin` / `getForAdmin` always return every known
 * page (synthesising an `exists: false` placeholder for pages never saved). `getPublished` is
 * the public read — it 404s a page that has not been created yet, and never leaks user ids.
 */
export class StaticPageService {
  public constructor(private readonly repository: StaticPageRepository) {}

  public async listForAdmin(): Promise<{ pages: StaticPageAdminDto[] }> {
    const docs = await this.repository.listAll();
    const byKey = new Map(docs.map((doc) => [doc.pageKey, doc]));
    return {
      pages: staticPageKeys.map((pageKey) =>
        toStaticPageAdminDto(pageKey, byKey.get(pageKey) ?? null),
      ),
    };
  }

  public async getForAdmin(pageKey: StaticPageKey): Promise<StaticPageAdminDto> {
    const doc = await this.repository.findByKey(pageKey);
    return toStaticPageAdminDto(pageKey, doc);
  }

  public async update(
    pageKey: StaticPageKey,
    actorUserId: string,
    request: UpdateStaticPageRequest,
  ): Promise<StaticPageAdminDto> {
    const doc = await this.repository.upsert(pageKey, {
      title: request.title.trim(),
      bodyHtml: sanitizeContentHtml(request.bodyHtml),
      actorUserId: new Types.ObjectId(actorUserId),
    });
    return toStaticPageAdminDto(pageKey, doc);
  }

  /** Public read — real persisted content only. 404 when the page has never been saved. */
  public async getPublished(pageKey: StaticPageKey): Promise<StaticPagePublicDto> {
    const doc = await this.repository.findByKey(pageKey);
    if (!doc) {
      throw new StaticPageError("STATIC_PAGE_NOT_FOUND", 404);
    }
    return toStaticPagePublicDto(doc);
  }
}
