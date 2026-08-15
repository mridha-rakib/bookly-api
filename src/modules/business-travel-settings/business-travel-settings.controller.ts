import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type {
  BusinessTravelSettingsParams,
  UpdateBusinessTravelSettingsBody,
} from "./business-travel-settings.schema.js";
import type { BusinessTravelSettingsService } from "./business-travel-settings.service.js";

export class BusinessTravelSettingsController {
  public constructor(
    private readonly businessTravelSettingsService: BusinessTravelSettingsService,
  ) {}

  public get = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as BusinessTravelSettingsParams;
    const result = await this.businessTravelSettingsService.getBusinessTravelSettings(
      userId,
      params.businessId,
    );
    sendSuccess(response, 200, "Business travel settings", result);
  };

  public update = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as BusinessTravelSettingsParams;
    const body = request.validated?.body as UpdateBusinessTravelSettingsBody;
    const result = await this.businessTravelSettingsService.updateBusinessTravelSettings(
      userId,
      params.businessId,
      body.cities,
    );
    sendSuccess(response, 200, "Business travel settings updated", result);
  };

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return userId;
  }
}
