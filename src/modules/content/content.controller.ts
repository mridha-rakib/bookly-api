import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import type { PublicListFaqsQuery } from "./faq.schema.js";
import type { FaqService } from "./faq.service.js";

/**
 * Public (no `authenticate` anywhere in the chain — see content.route.ts) Content reads. FAQ
 * content is public-facing marketing/help content, so it is genuinely anonymous, rate-limited
 * the same way `discovery.route.ts` / `contact.route.ts` guard their anonymous endpoints.
 * Returns PUBLISHED rows only — draft filtering lives in `FaqService.listPublished`.
 */
export class ContentController {
  public constructor(private readonly faqService: FaqService) {}

  public listPublicFaqs = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as PublicListFaqsQuery;
    const faqs = await this.faqService.listPublished(query.audience);
    sendSuccess(response, 200, "FAQs", { faqs });
  };
}
