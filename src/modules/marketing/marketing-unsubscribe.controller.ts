import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { MarketingError } from "./marketing.errors.js";
import type {
  MarketingUnsubscribeBody,
  MarketingUnsubscribeQuery,
} from "./marketing-unsubscribe.schema.js";
import type { MarketingUnsubscribeService } from "./marketing-unsubscribe.service.js";

/**
 * Public, unauthenticated marketing unsubscribe. Accepts the token from the query string (RFC
 * 8058 one-click POST) or the JSON body (web-app confirmation page); a missing token is the same
 * generic failure as an invalid one. Always returns a bare `{ success: true }` on success — no
 * "already unsubscribed" / "not found" variants that could be probed for account existence.
 */
export class MarketingUnsubscribeController {
  public constructor(private readonly service: MarketingUnsubscribeService) {}

  public unsubscribe = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as MarketingUnsubscribeQuery | undefined;
    const body = request.validated?.body as MarketingUnsubscribeBody | undefined;
    const token = (query?.token ?? body?.token ?? "").trim();

    if (!token) {
      throw new MarketingError("MARKETING_UNSUBSCRIBE_LINK_INVALID", 400);
    }

    await this.service.unsubscribe(token);

    sendSuccess(response, 200, "You have been unsubscribed from marketing emails.");
  };
}
