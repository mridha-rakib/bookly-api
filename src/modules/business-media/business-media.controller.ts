import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type { BusinessIdParams } from "../business/business.schema.js";
import type { MediaIdParams } from "./business-media.schema.js";
import type { BusinessMediaService } from "./business-media.service.js";

export class BusinessMediaController {
  public constructor(private readonly businessMediaService: BusinessMediaService) {}

  public list = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as BusinessIdParams;
    const result = await this.businessMediaService.listBusinessMedia(userId, params.businessId);
    sendSuccess(response, 200, "Business media", result);
  };

  public upload = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as BusinessIdParams;
    const file = request.file
      ? {
          buffer: request.file.buffer,
          mimeType: request.file.mimetype,
          size: request.file.size,
          originalFileName: request.file.originalname,
        }
      : undefined;
    const result = await this.businessMediaService.uploadBusinessMedia(
      userId,
      params.businessId,
      file,
    );
    sendSuccess(response, 201, "Business media uploaded", result);
  };

  public remove = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as MediaIdParams;
    await this.businessMediaService.deleteBusinessMedia(userId, params.businessId, params.mediaId);
    sendSuccess(response, 200, "Business media deleted");
  };

  public setProfile = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as MediaIdParams;
    const result = await this.businessMediaService.setProfileMedia(
      userId,
      params.businessId,
      params.mediaId,
    );
    sendSuccess(response, 200, "Business profile image updated", result);
  };

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return userId;
  }
}
