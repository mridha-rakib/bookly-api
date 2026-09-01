import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type {
  CreateMarketingCampaignBody,
  ListMarketingCampaignsQuery,
  MarketingCampaignIdParams,
  ScheduleMarketingCampaignBody,
} from "./marketing-campaign.schema.js";
import type { MarketingCampaignService } from "./marketing-campaign.service.js";

/**
 * Marketing Email Stage M3A — SUPER_ADMIN campaign domain + audience API. Mounted under
 * `/super-admin`, gated end-to-end by `requireRoles(["SUPER_ADMIN"])` (router-wide, same as
 * every other Super Admin controller). Manages campaign identity, scheduling metadata and
 * audience materialization ONLY — there is no send endpoint, and nothing here touches email.
 */
export class MarketingCampaignController {
  public constructor(private readonly service: MarketingCampaignService) {}

  public create = async (request: Request, response: Response): Promise<void> => {
    const body = request.validated?.body as CreateMarketingCampaignBody;
    const dto = await this.service.create(this.actorId(request), {
      type: body.type,
      sourceId: body.sourceId,
      ...(body.scheduledAt ? { scheduledAt: new Date(body.scheduledAt) } : {}),
    });
    sendSuccess(response, 201, "Campaign created", dto);
  };

  public list = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as ListMarketingCampaignsQuery;
    const result = await this.service.list({ page: query.page, limit: query.limit });
    sendSuccess(response, 200, "Campaigns", result);
  };

  public getById = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as MarketingCampaignIdParams;
    sendSuccess(response, 200, "Campaign", await this.service.getById(params.campaignId));
  };

  public schedule = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as MarketingCampaignIdParams;
    const body = request.validated?.body as ScheduleMarketingCampaignBody;
    const dto = await this.service.schedule(
      params.campaignId,
      body.scheduledAt ? new Date(body.scheduledAt) : undefined,
    );
    sendSuccess(response, 200, "Campaign scheduled", dto);
  };

  public materialize = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as MarketingCampaignIdParams;
    sendSuccess(
      response,
      200,
      "Audience materialized",
      await this.service.materialize(params.campaignId),
    );
  };

  public cancel = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as MarketingCampaignIdParams;
    sendSuccess(response, 200, "Campaign cancelled", await this.service.cancel(params.campaignId));
  };

  private actorId(request: Request): string {
    if (!request.auth?.userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }
    return request.auth.userId;
  }
}
