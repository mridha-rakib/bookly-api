import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import type { BlogSlugParams, ListPublicBlogQuery } from "./blog.schema.js";
import type { BlogService } from "./blog.service.js";
import type { PublicListFaqsQuery } from "./faq.schema.js";
import type { FaqService } from "./faq.service.js";
import type { StaticPageKeyParams } from "./static-page.schema.js";
import type { StaticPageService } from "./static-page.service.js";

/**
 * Public (no `authenticate` anywhere in the chain — see content.route.ts) Content reads. FAQ and
 * Blog content is public-facing, so these are genuinely anonymous, rate-limited the same way
 * `discovery.route.ts` / `contact.route.ts` guard their anonymous endpoints. Draft filtering
 * lives in the services (`FaqService.listPublished`, `BlogService.listPublished` /
 * `getPublishedBySlug`) — never in this controller.
 */
export class ContentController {
  public constructor(
    private readonly faqService: FaqService,
    private readonly blogService: BlogService,
    private readonly staticPageService: StaticPageService,
  ) {}

  public listPublicFaqs = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as PublicListFaqsQuery;
    const faqs = await this.faqService.listPublished(query.audience);
    sendSuccess(response, 200, "FAQs", { faqs });
  };

  public listPublicBlog = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as ListPublicBlogQuery;
    const result = await this.blogService.listPublished(
      { category: query.category },
      { page: query.page, limit: query.limit },
    );
    sendSuccess(response, 200, "Blog posts", result);
  };

  public getPublicBlogBySlug = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as BlogSlugParams;
    const post = await this.blogService.getPublishedBySlug(params.slug);
    sendSuccess(response, 200, "Blog post", post);
  };

  public getPublicStaticPage = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as StaticPageKeyParams;
    const page = await this.staticPageService.getPublished(params.pageKey);
    sendSuccess(response, 200, "Static page", page);
  };
}
