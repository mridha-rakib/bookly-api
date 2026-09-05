import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type { PackageProgressIdOnlyParams } from "./package-progress.schema.js";
import type { PackageProgressService } from "./package-progress.service.js";

/** Customer self-service "My Packages" read surface — cross-business, same pattern as
 * BookingController's Customer-side methods (see booking.controller.ts). */
export class PackageProgressController {
  public constructor(private readonly packageProgressService: PackageProgressService) {}

  public listForCustomer = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const packages = await this.packageProgressService.listForCustomer(userId);
    sendSuccess(response, 200, "My packages", { packages });
  };

  public getForCustomer = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const params = request.validated?.params as PackageProgressIdOnlyParams;

    const progress = await this.packageProgressService.getForCustomer(
      userId,
      params.packageProgressId,
    );

    sendSuccess(response, 200, "Package", progress);
  };

  private requireCustomerId(request: Request): string {
    const userId = request.auth?.userId;
    const role = request.auth?.role;

    if (!userId || role !== "CUSTOMER") {
      throw new AuthError("PORTAL_MISMATCH", 403);
    }

    return userId;
  }
}
