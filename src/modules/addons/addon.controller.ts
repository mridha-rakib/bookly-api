import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type {
  AddonBusinessParams,
  AddonIdParams,
  CreateAddonBody,
  ListAddonsQuery,
  RestoreAddonBody,
  UpdateAddonBody,
  UpdateAddonStatusBody,
} from "./addon.schema.js";
import type { AddonService } from "./addon.service.js";
import type { AddonServiceIdParams } from "./addon-service-assignment.schema.js";

export class AddonController {
  public constructor(private readonly addonService: AddonService) {}

  public list = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as AddonBusinessParams;
    const query = request.validated?.query as ListAddonsQuery;
    const result = await this.addonService.listAddons(userId, params.businessId, {
      status: query.status,
      archivedOnly: query.archived,
    });
    sendSuccess(response, 200, "Add-ons", result);
  };

  public getById = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as AddonIdParams;
    const result = await this.addonService.getAddon(userId, params.businessId, params.addonId);
    sendSuccess(response, 200, "Add-on", result);
  };

  public create = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as AddonBusinessParams;
    const body = request.validated?.body as CreateAddonBody;
    const result = await this.addonService.createAddon(userId, params.businessId, body);
    sendSuccess(response, 201, "Add-on created", result);
  };

  public update = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as AddonIdParams;
    const body = request.validated?.body as UpdateAddonBody;
    const result = await this.addonService.updateAddon(
      userId,
      params.businessId,
      params.addonId,
      body,
    );
    sendSuccess(response, 200, "Add-on updated", result);
  };

  public updateStatus = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as AddonIdParams;
    const body = request.validated?.body as UpdateAddonStatusBody;
    const result = await this.addonService.updateAddonStatus(
      userId,
      params.businessId,
      params.addonId,
      body.status,
    );
    sendSuccess(response, 200, "Add-on status updated", result);
  };

  public archive = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as AddonIdParams;
    await this.addonService.archiveAddon(userId, params.businessId, params.addonId);
    sendSuccess(response, 200, "Add-on archived");
  };

  public restore = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as AddonIdParams;
    const body = request.validated?.body as RestoreAddonBody;
    const result = await this.addonService.restoreAddon(
      userId,
      params.businessId,
      params.addonId,
      body.status,
    );
    sendSuccess(response, 200, "Add-on restored", result);
  };

  public listForService = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as AddonServiceIdParams;
    const result = await this.addonService.listAddonsForService(
      userId,
      params.businessId,
      params.serviceId,
    );
    sendSuccess(response, 200, "Assigned add-ons", result);
  };

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return userId;
  }
}
