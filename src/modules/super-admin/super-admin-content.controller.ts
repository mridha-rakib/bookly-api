import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type {
  BlogMediaIdParams,
  BlogPostIdParams,
  CreateBlogBody,
  ListAdminBlogQuery,
  UpdateBlogBody,
} from "../content/blog.schema.js";
import type { BlogService } from "../content/blog.service.js";
import type {
  CreateFaqBody,
  FaqIdParams,
  ListAdminFaqsQuery,
  ReorderFaqsBody,
  UpdateFaqBody,
} from "../content/faq.schema.js";
import type { FaqService } from "../content/faq.service.js";
import type { StaticPageKeyParams, UpdateStaticPageBody } from "../content/static-page.schema.js";
import type { StaticPageService } from "../content/static-page.service.js";

/**
 * Mounted under `/super-admin`, gated end-to-end by the router-wide `requireRoles(["SUPER_ADMIN"])`
 * gate (see super-admin.route.ts) — same precedent as every other Super Admin controller. There
 * is no Business-scoped variant of any FAQ / Blog / Static Page route; Content Manager is
 * SUPER_ADMIN-only, full stop.
 */
export class SuperAdminContentController {
  public constructor(
    private readonly faqService: FaqService,
    private readonly blogService: BlogService,
    private readonly staticPageService: StaticPageService,
  ) {}

  // --- FAQ ------------------------------------------------------------------------------

  public listFaqs = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as ListAdminFaqsQuery;
    const faqs = await this.faqService.listForAdmin(query.audience, query.status);
    sendSuccess(response, 200, "FAQs", { faqs });
  };

  public createFaq = async (request: Request, response: Response): Promise<void> => {
    const body = request.validated?.body as CreateFaqBody;
    const superAdminUserId = this.requireActorId(request);
    const faq = await this.faqService.create(superAdminUserId, {
      question: body.question,
      answer: body.answer,
      audience: body.audience,
      status: body.status,
    });
    sendSuccess(response, 201, "FAQ created", faq);
  };

  public updateFaq = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as FaqIdParams;
    const body = request.validated?.body as UpdateFaqBody;
    const faq = await this.faqService.update(params.faqId, body);
    sendSuccess(response, 200, "FAQ updated", faq);
  };

  public deleteFaq = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as FaqIdParams;
    const result = await this.faqService.delete(params.faqId);
    sendSuccess(response, 200, "FAQ deleted", result);
  };

  public reorderFaqs = async (request: Request, response: Response): Promise<void> => {
    const body = request.validated?.body as ReorderFaqsBody;
    const faqs = await this.faqService.reorder(body.audience, body.orderedIds);
    sendSuccess(response, 200, "FAQs reordered", { faqs });
  };

  // --- Blog -----------------------------------------------------------------------------

  public listBlog = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as ListAdminBlogQuery;
    const result = await this.blogService.listForAdmin(
      { category: query.category, status: query.status },
      { page: query.page, limit: query.limit },
    );
    sendSuccess(response, 200, "Blog posts", result);
  };

  public getBlog = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as BlogPostIdParams;
    const post = await this.blogService.getByIdForAdmin(params.postId);
    sendSuccess(response, 200, "Blog post", post);
  };

  public createBlog = async (request: Request, response: Response): Promise<void> => {
    const body = request.validated?.body as CreateBlogBody;
    const superAdminUserId = this.requireActorId(request);
    const post = await this.blogService.create(superAdminUserId, {
      title: body.title,
      slug: body.slug,
      excerpt: body.excerpt,
      bodyHtml: body.bodyHtml,
      category: body.category,
      status: body.status,
      coverMediaId: body.coverMediaId,
      galleryMediaIds: body.galleryMediaIds,
      facebookUrl: body.facebookUrl,
      instagramUrl: body.instagramUrl,
    });
    sendSuccess(response, 201, "Blog post created", post);
  };

  public updateBlog = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as BlogPostIdParams;
    const body = request.validated?.body as UpdateBlogBody;
    const post = await this.blogService.update(params.postId, body);
    sendSuccess(response, 200, "Blog post updated", post);
  };

  public deleteBlog = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as BlogPostIdParams;
    const result = await this.blogService.delete(params.postId);
    sendSuccess(response, 200, "Blog post deleted", result);
  };

  public uploadBlogMedia = async (request: Request, response: Response): Promise<void> => {
    const superAdminUserId = this.requireActorId(request);
    const file = request.file
      ? {
          buffer: request.file.buffer,
          mimeType: request.file.mimetype,
          size: request.file.size,
          originalFileName: request.file.originalname,
        }
      : undefined;
    const media = await this.blogService.uploadMedia(superAdminUserId, file);
    sendSuccess(response, 201, "Blog image uploaded", media);
  };

  public deleteBlogMedia = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as BlogMediaIdParams;
    const result = await this.blogService.deleteMedia(params.mediaId);
    sendSuccess(response, 200, "Blog image deleted", result);
  };

  // --- Static Pages (Phase 3) -----------------------------------------------------------

  public listStaticPages = async (_request: Request, response: Response): Promise<void> => {
    const result = await this.staticPageService.listForAdmin();
    sendSuccess(response, 200, "Static pages", result);
  };

  public getStaticPage = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as StaticPageKeyParams;
    const page = await this.staticPageService.getForAdmin(params.pageKey);
    sendSuccess(response, 200, "Static page", page);
  };

  public updateStaticPage = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as StaticPageKeyParams;
    const body = request.validated?.body as UpdateStaticPageBody;
    const superAdminUserId = this.requireActorId(request);
    const page = await this.staticPageService.update(params.pageKey, superAdminUserId, {
      title: body.title,
      bodyHtml: body.bodyHtml,
    });
    sendSuccess(response, 200, "Static page updated", page);
  };

  private requireActorId(request: Request): string {
    if (!request.auth?.userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }
    return request.auth.userId;
  }
}
