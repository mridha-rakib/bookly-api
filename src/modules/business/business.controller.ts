import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type {
  BusinessIdParams,
  RequestLinkVerificationBody,
  UpdateBusinessBody,
  VerificationIdParams,
  VerifyLinkVerificationBody,
} from "./business.schema.js";
import type { BusinessService } from "./business.service.js";

export class BusinessController {
  public constructor(private readonly businessService: BusinessService) {}

  public getMyProfile = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const result = await this.businessService.getBusinessProfile(userId);
    sendSuccess(response, 200, "Business profile", result);
  };

  public getById = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as BusinessIdParams;
    const result = await this.businessService.getBusinessDetail(userId, params.businessId);
    sendSuccess(response, 200, "Business detail", result);
  };

  public update = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as BusinessIdParams;
    const body = request.validated?.body as UpdateBusinessBody;
    const result = await this.businessService.updateOwnedBusiness(userId, params.businessId, body);
    sendSuccess(response, 200, "Business updated", result);
  };

  public requestLinkVerification = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const body = request.validated?.body as RequestLinkVerificationBody;
    const result = await this.businessService.requestLinkVerification(userId, body.email);
    sendSuccess(response, 201, "Verification code sent", result);
  };

  public resendLinkVerification = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as VerificationIdParams;
    const result = await this.businessService.resendLinkVerification(userId, params.verificationId);
    sendSuccess(response, 200, "Verification code resent", result);
  };

  public verifyLinkVerification = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as VerificationIdParams;
    const body = request.validated?.body as VerifyLinkVerificationBody;
    const result = await this.businessService.verifyLinkVerification(
      userId,
      params.verificationId,
      body.code,
    );
    sendSuccess(response, 201, "Business linked", result);
  };

  public unlink = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as BusinessIdParams;
    await this.businessService.unlinkBusiness(userId, params.businessId);
    sendSuccess(response, 200, "Business unlinked");
  };

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return userId;
  }
}
