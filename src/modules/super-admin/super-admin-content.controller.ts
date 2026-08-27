import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type {
  CreateFaqBody,
  FaqIdParams,
  ListAdminFaqsQuery,
  ReorderFaqsBody,
  UpdateFaqBody,
} from "../content/faq.schema.js";
import type { FaqService } from "../content/faq.service.js";

/**
 * Mounted under `/super-admin`, gated end-to-end by the router-wide `requireRoles(["SUPER_ADMIN"])`
 * gate (see super-admin.route.ts) — same precedent as every other Super Admin controller. There
 * is no Business-scoped variant of any FAQ route; FAQ management is SUPER_ADMIN-only, full stop.
 */
export class SuperAdminContentController {
  public constructor(private readonly faqService: FaqService) {}

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

  private requireActorId(request: Request): string {
    if (!request.auth?.userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }
    return request.auth.userId;
  }
}
