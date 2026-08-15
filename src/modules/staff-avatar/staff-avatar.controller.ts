import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type { StaffIdParams } from "../staff/staff.schema.js";
import type { StaffAvatarService } from "./staff-avatar.service.js";

export class StaffAvatarController {
  public constructor(private readonly staffAvatarService: StaffAvatarService) {}

  public upload = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as StaffIdParams;
    const file = request.file
      ? {
          buffer: request.file.buffer,
          mimeType: request.file.mimetype,
          size: request.file.size,
          originalFileName: request.file.originalname,
        }
      : undefined;
    const result = await this.staffAvatarService.uploadOrReplaceAvatar(
      userId,
      params.businessId,
      params.staffId,
      file,
    );
    sendSuccess(response, 200, "Staff avatar updated", result);
  };

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return userId;
  }
}
