import { Router } from "express";
import rateLimit from "express-rate-limit";

import { buildErrorResponse } from "../../common/http/responses.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { env } from "../../config/env.js";
import { createDeferredStorageServiceFromEnv } from "../storage/storage.service.js";
import { BlogPostRepository } from "./blog.repository.js";
import { blogSlugParamsSchema, listPublicBlogQuerySchema } from "./blog.schema.js";
import { BlogService } from "./blog.service.js";
import { BlogMediaRepository } from "./blog-media.repository.js";
import { ContentController } from "./content.controller.js";
import { FaqRepository } from "./faq.repository.js";
import { publicListFaqsQuerySchema } from "./faq.schema.js";
import { FaqService } from "./faq.service.js";
import { StaticPageRepository } from "./static-page.repository.js";
import { staticPageKeyParamsSchema } from "./static-page.schema.js";
import { StaticPageService } from "./static-page.service.js";

/**
 * Public Content reads (FAQ + Blog). Genuinely anonymous — no `authenticate` in the chain —
 * matching the real precedent `discovery.route.ts` / `contact.route.ts` set for public GETs in
 * this codebase. Rate limited instead of auth-gated. Every Blog response here is PUBLISHED-only;
 * all Super Admin mutations live on `/super-admin/content` behind the SUPER_ADMIN router-wide
 * gate — never here.
 */
export const createPublicContentRoute = (): Router => {
  const router = Router();
  const blogService = new BlogService(
    new BlogPostRepository(),
    new BlogMediaRepository(),
    createDeferredStorageServiceFromEnv(),
    { maxUploadBytes: env.BUSINESS_MEDIA_MAX_UPLOAD_BYTES },
  );
  const controller = new ContentController(
    new FaqService(new FaqRepository()),
    blogService,
    new StaticPageService(new StaticPageRepository()),
  );

  const contentLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: env.RATE_LIMIT_MAX,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: buildErrorResponse("Too many requests"),
  });

  router.get(
    "/faqs",
    contentLimiter,
    validateRequest({ query: publicListFaqsQuerySchema }),
    asyncHandler(controller.listPublicFaqs),
  );

  router.get(
    "/blog",
    contentLimiter,
    validateRequest({ query: listPublicBlogQuerySchema }),
    asyncHandler(controller.listPublicBlog),
  );
  router.get(
    "/blog/:slug",
    contentLimiter,
    validateRequest({ params: blogSlugParamsSchema }),
    asyncHandler(controller.getPublicBlogBySlug),
  );

  router.get(
    "/pages/:pageKey",
    contentLimiter,
    validateRequest({ params: staticPageKeyParamsSchema }),
    asyncHandler(controller.getPublicStaticPage),
  );

  return router;
};
