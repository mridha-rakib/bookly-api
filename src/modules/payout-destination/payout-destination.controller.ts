import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type {
  PayoutDestinationBusinessParams,
  UpdatePayoutDestinationBody,
  VerifyPayoutStepUpOtpBody,
} from "./payout-destination.schema.js";
import type { PayoutDestinationService } from "./payout-destination.service.js";

/**
 * Mounted inside business.route.ts underneath its existing `requireRoles(["BUSINESS_OWNER"])`
 * gate (see payout-destination.route.ts's own comment) — every request reaching here already
 * carries a BUSINESS_OWNER actor, and the service independently verifies that Owner actually
 * OWNS this businessId.
 *
 * `businessId` is read ONLY from the validated route params, and `userId` ONLY from
 * `request.auth` — a body-supplied businessId/ownerId is rejected outright by the body schema's
 * `.strict()` and would be ignored here regardless. No handler in this file logs a request body.
 */
export class PayoutDestinationController {
  public constructor(private readonly payoutDestinationService: PayoutDestinationService) {}

  public get = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as PayoutDestinationBusinessParams;

    const view = await this.payoutDestinationService.getForOwner(userId, params.businessId);

    sendSuccess(response, 200, "Payout destination", view);
  };

  /** Create-or-replace — one handler, because one Business has at most one destination. */
  public update = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as PayoutDestinationBusinessParams;
    const body = request.validated?.body as UpdatePayoutDestinationBody;

    const view = await this.payoutDestinationService.upsertForOwner(
      userId,
      params.businessId,
      body,
    );

    sendSuccess(response, 200, "Payout destination saved", view);
  };

  public requestStepUpOtp = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as PayoutDestinationBusinessParams;

    const result = await this.payoutDestinationService.requestStepUpOtp(userId, params.businessId);

    sendSuccess(response, 200, "Verification code sent", result);
  };

  public verifyStepUpOtp = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as PayoutDestinationBusinessParams;
    const body = request.validated?.body as VerifyPayoutStepUpOtpBody;

    const result = await this.payoutDestinationService.verifyStepUpOtp(
      userId,
      params.businessId,
      body.code,
    );

    sendSuccess(response, 200, "Verification confirmed", result);
  };

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return userId;
  }
}
