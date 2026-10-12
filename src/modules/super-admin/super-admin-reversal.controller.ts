import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import { FinanceError } from "../finance/finance.errors.js";
import type { ProviderReversalQueryService } from "../provider-reversal/provider-reversal.query.js";
import type {
  DisputeListQuery,
  DisputeParams,
  ExternalRefundListQuery,
  WebhookEventListQuery,
  WebhookEventParams,
} from "../provider-reversal/provider-reversal.schema.js";
import type { StripeWebhookService } from "../stripe-webhook/stripe-webhook.service.js";
import type { StripeWebhookEventDocument } from "../stripe-webhook/stripe-webhook-event.model.js";
import type { StripeWebhookEventRepository } from "../stripe-webhook/stripe-webhook-event.repository.js";

/** The support projection of a stored webhook event: never its raw payload. */
const toWebhookEventDto = (event: StripeWebhookEventDocument) => ({
  eventId: event.eventId,
  type: event.type,
  status: event.status,
  attemptCount: event.attemptCount,
  error: event.error,
  nextAttemptAt: event.nextAttemptAt?.toISOString(),
  replayable: event.status === "FAILED" && event.payload !== undefined,
  replayCount: event.replayCount ?? 0,
  lastReplayedAt: event.lastReplayedAt?.toISOString(),
  createdAt: event.createdAt.toISOString(),
  updatedAt: event.updatedAt.toISOString(),
});

/**
 * P6 — Super Admin support visibility of provider-originated reversals (disputes, refunds made
 * outside Bookly) and of the Stripe webhook queue, plus the explicit replay of a FAILED event.
 * Gated by the router-wide SUPER_ADMIN role (super-admin.route.ts). Read-only except replay,
 * which only re-runs the idempotent webhook handlers. Dispute evidence stays in the Stripe
 * Dashboard; nothing here moves money.
 */
export class SuperAdminReversalController {
  public constructor(
    private readonly reversals: ProviderReversalQueryService,
    private readonly webhookEvents: Pick<StripeWebhookEventRepository, "listByStatus">,
    private readonly webhookService: Pick<StripeWebhookService, "replayEvent">,
  ) {}

  public listDisputes = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as DisputeListQuery;
    const page = await this.reversals.listDisputes(query);
    sendSuccess(response, 200, "Payment disputes", {
      disputes: page.items,
      pagination: { page: query.page, limit: query.limit, total: page.total },
    });
  };

  public getDispute = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as DisputeParams;
    const dispute = await this.reversals.getDispute(params.disputeId);
    if (!dispute) throw new FinanceError("FINANCE_DISPUTE_NOT_FOUND", 404);
    sendSuccess(response, 200, "Payment dispute", dispute);
  };

  public listExternalRefunds = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as ExternalRefundListQuery;
    const page = await this.reversals.listExternalRefunds(query);
    sendSuccess(response, 200, "External refunds", {
      refunds: page.items,
      pagination: { page: query.page, limit: query.limit, total: page.total },
    });
  };

  public listWebhookEvents = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as WebhookEventListQuery;
    const page = await this.webhookEvents.listByStatus(query);
    sendSuccess(response, 200, "Stripe webhook events", {
      events: page.items.map(toWebhookEventDto),
      pagination: { page: query.page, limit: query.limit, total: page.total },
    });
  };

  public replayWebhookEvent = async (request: Request, response: Response): Promise<void> => {
    const userId = request.auth?.userId;
    if (!userId) throw new AuthError("SESSION_EXPIRED", 401);
    const params = request.validated?.params as WebhookEventParams;
    const outcome = await this.webhookService.replayEvent(params.eventId, userId);
    if (outcome === "NOT_FOUND") throw new FinanceError("FINANCE_WEBHOOK_EVENT_NOT_FOUND", 404);
    if (outcome === "NOT_FAILED") {
      throw new FinanceError("FINANCE_WEBHOOK_EVENT_NOT_REPLAYABLE", 409);
    }
    sendSuccess(response, 200, "Webhook event replayed", { eventId: params.eventId, outcome });
  };
}
