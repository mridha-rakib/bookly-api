import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type { StaffBusinessParams, StaffIdParams } from "../staff/staff.schema.js";
import type { StaffAvatarService } from "./staff-avatar.service.js";

export class StaffAvatarController {
  public constructor(private readonly staffAvatarService: StaffAvatarService) {}

  public upload = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as StaffIdParams;
    const file = this.extractFile(request);
    const result = await this.staffAvatarService.uploadOrReplaceAvatar(
      userId,
      params.businessId,
      params.staffId,
      file,
    );
    sendSuccess(response, 200, "Staff avatar updated", result);
  };

  /** Business Owner self-service — no `staffId`, the subject is always the caller themselves
   * (resolved server-side from `business.ownerUserId`, never from request input). */
  public uploadOwnerAvatar = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as StaffBusinessParams;
    const file = this.extractFile(request);
    const result = await this.staffAvatarService.uploadOrReplaceOwnerAvatar(
      userId,
      params.businessId,
      file,
    );
    sendSuccess(response, 200, "Owner avatar updated", result);
  };

  private extractFile(request: Request) {
    return request.file
      ? {
          buffer: request.file.buffer,
          mimeType: request.file.mimetype,
          size: request.file.size,
          originalFileName: request.file.originalname,
        }
      : undefined;
  }

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return userId;
  }
}
