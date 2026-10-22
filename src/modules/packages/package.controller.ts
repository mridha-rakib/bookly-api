import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type { PackageListFilter } from "./package.repository.js";
import type { CreatePackageBody, UpdatePackageBody } from "./package.schema.js";
import type { PackageService } from "./package.service.js";
import type { EditablePackageStatus } from "./package.types.js";

export class PackageController {
  public constructor(private readonly service: PackageService) {}
  private context(request: Request) {
    if (!request.auth?.userId) throw new AuthError("SESSION_EXPIRED", 401);
    return {
      actor: request.auth.userId,
      ...(request.validated?.params as { businessId: string; packageId: string }),
    };
  }
  public list = async (request: Request, response: Response): Promise<void> => {
    const { actor, businessId } = this.context(request);
    sendSuccess(
      response,
      200,
      "Packages",
      await this.service.list(actor, businessId, request.validated?.query as PackageListFilter),
    );
  };
  public detail = async (request: Request, response: Response): Promise<void> => {
    const { actor, businessId, packageId } = this.context(request);
    sendSuccess(response, 200, "Package", await this.service.detail(actor, businessId, packageId));
  };
  public create = async (request: Request, response: Response): Promise<void> => {
    const { actor, businessId } = this.context(request);
    sendSuccess(
      response,
      201,
      "Package created",
      await this.service.create(actor, businessId, request.validated?.body as CreatePackageBody),
    );
  };
  public update = async (request: Request, response: Response): Promise<void> => {
    const { actor, businessId, packageId } = this.context(request);
    sendSuccess(
      response,
      200,
      "Package updated",
      await this.service.update(
        actor,
        businessId,
        packageId,
        request.validated?.body as UpdatePackageBody,
      ),
    );
  };
  public status = async (request: Request, response: Response): Promise<void> => {
    const { actor, businessId, packageId } = this.context(request);
    const body = request.validated?.body as {
      status: EditablePackageStatus;
      expectedRevision: number;
    };
    sendSuccess(
      response,
      200,
      "Package status updated",
      await this.service.status(actor, businessId, packageId, body.status, body.expectedRevision),
    );
  };
  public archive = async (request: Request, response: Response): Promise<void> => {
    const { actor, businessId, packageId } = this.context(request);
    const query = request.validated?.query as { expectedRevision: number };
    await this.service.archive(actor, businessId, packageId, query.expectedRevision);
    sendSuccess(response, 200, "Package archived");
  };
  public restore = async (request: Request, response: Response): Promise<void> => {
    const { actor, businessId, packageId } = this.context(request);
    const body = request.validated?.body as {
      status: "ACTIVE" | "INACTIVE";
      expectedRevision: number;
    };
    sendSuccess(
      response,
      200,
      "Package restored",
      await this.service.restore(actor, businessId, packageId, body.status, body.expectedRevision),
    );
  };
}
