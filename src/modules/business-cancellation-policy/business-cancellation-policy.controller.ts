import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type {
  CancellationPolicyParams,
  PutCancellationPolicyBody,
} from "./business-cancellation-policy.schema.js";
import type { BusinessCancellationPolicyService } from "./business-cancellation-policy.service.js";

export class BusinessCancellationPolicyController {
  public constructor(private readonly policyService: BusinessCancellationPolicyService) {}

  public get = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as CancellationPolicyParams;
    const result = await this.policyService.getPolicy(userId, params.businessId);
    sendSuccess(response, 200, "Business cancellation policy", result);
  };

  public put = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as CancellationPolicyParams;
    const body = request.validated?.body as PutCancellationPolicyBody;
    const result = await this.policyService.putPolicy(userId, params.businessId, body);
    sendSuccess(response, 200, "Business cancellation policy updated", result);
  };

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return userId;
  }
}
