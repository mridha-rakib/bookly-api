import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type {
  BusinessBookingSettingsParams,
  UpdateBusinessBookingSettingsBody,
} from "./business-booking-settings.schema.js";
import type { BusinessBookingSettingsService } from "./business-booking-settings.service.js";

export class BusinessBookingSettingsController {
  public constructor(
    private readonly businessBookingSettingsService: BusinessBookingSettingsService,
  ) {}

  public get = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as BusinessBookingSettingsParams;
    const result = await this.businessBookingSettingsService.getBookingSettings(
      userId,
      params.businessId,
    );
    sendSuccess(response, 200, "Business booking settings", result);
  };

  public update = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as BusinessBookingSettingsParams;
    const body = request.validated?.body as UpdateBusinessBookingSettingsBody;
    const result = await this.businessBookingSettingsService.updateBookingSettings(
      userId,
      params.businessId,
      body.gapEliminationEnabled,
    );
    sendSuccess(response, 200, "Business booking settings updated", result);
  };

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return userId;
  }
}
