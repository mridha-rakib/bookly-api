import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type {
  CreateServiceBody,
  CreateServiceCategoryBody,
  ListServiceCategoriesQuery,
  ListServicesQuery,
  RestoreServiceBody,
  ServiceBusinessParams,
  ServiceCategoryIdParams,
  ServiceIdParams,
  UpdateServiceBody,
  UpdateServiceCategoryBody,
  UpdateServiceStatusBody,
} from "./service.schema.js";
import type { ServiceService } from "./service.service.js";

export class ServiceController {
  public constructor(private readonly serviceService: ServiceService) {}

  // --- Service Categories -----------------------------------------------------------------

  public listCategories = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as ServiceBusinessParams;
    const query = request.validated?.query as ListServiceCategoriesQuery;
    const result = await this.serviceService.listCategories(
      userId,
      params.businessId,
      query.includeInactive,
    );
    sendSuccess(response, 200, "Service categories", result);
  };

  public createCategory = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as ServiceBusinessParams;
    const body = request.validated?.body as CreateServiceCategoryBody;
    const result = await this.serviceService.createCategory(userId, params.businessId, body.name);
    sendSuccess(response, 201, "Service category created", result);
  };

  public updateCategory = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as ServiceCategoryIdParams;
    const body = request.validated?.body as UpdateServiceCategoryBody;
    const result = await this.serviceService.updateCategory(
      userId,
      params.businessId,
      params.categoryId,
      body,
    );
    sendSuccess(response, 200, "Service category updated", result);
  };

  // --- Services ------------------------------------------------------------------------------

  public list = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as ServiceBusinessParams;
    const query = request.validated?.query as ListServicesQuery;
    const result = await this.serviceService.listServices(userId, params.businessId, {
      status: query.status,
      archivedOnly: query.archived,
    });
    sendSuccess(response, 200, "Services", result);
  };

  public getById = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as ServiceIdParams;
    const result = await this.serviceService.getService(
      userId,
      params.businessId,
      params.serviceId,
    );
    sendSuccess(response, 200, "Service", result);
  };

  public create = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as ServiceBusinessParams;
    const body = request.validated?.body as CreateServiceBody;
    const result = await this.serviceService.createService(userId, params.businessId, body);
    sendSuccess(response, 201, "Service created", result);
  };

  public update = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as ServiceIdParams;
    const body = request.validated?.body as UpdateServiceBody;
    const result = await this.serviceService.updateService(
      userId,
      params.businessId,
      params.serviceId,
      body,
    );
    sendSuccess(response, 200, "Service updated", result);
  };

  public updateStatus = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as ServiceIdParams;
    const body = request.validated?.body as UpdateServiceStatusBody;
    const result = await this.serviceService.updateServiceStatus(
      userId,
      params.businessId,
      params.serviceId,
      body.status,
    );
    sendSuccess(response, 200, "Service status updated", result);
  };

  public archive = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as ServiceIdParams;
    await this.serviceService.archiveService(userId, params.businessId, params.serviceId);
    sendSuccess(response, 200, "Service archived");
  };

  public restore = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as ServiceIdParams;
    const body = request.validated?.body as RestoreServiceBody;
    const result = await this.serviceService.restoreService(
      userId,
      params.businessId,
      params.serviceId,
      body.status,
    );
    sendSuccess(response, 200, "Service restored", result);
  };

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return userId;
  }
}
