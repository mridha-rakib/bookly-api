import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type { BusinessHoursParams, PutBusinessHoursBody } from "./business-hours.schema.js";
import type { BusinessHoursService } from "./business-hours.service.js";

export class BusinessHoursController {
  public constructor(private readonly businessHoursService: BusinessHoursService) {}

  public get = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as BusinessHoursParams;
    const result = await this.businessHoursService.getOpeningHours(userId, params.businessId);
    sendSuccess(response, 200, "Business opening hours", result);
  };

  public put = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as BusinessHoursParams;
    const body = request.validated?.body as PutBusinessHoursBody;
    const result = await this.businessHoursService.putOpeningHours(
      userId,
      params.businessId,
      body.days,
    );
    sendSuccess(response, 200, "Business opening hours updated", result);
  };

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return userId;
  }
}
