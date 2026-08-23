import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import type {
  CatalogAvailabilityQuery,
  CatalogBusinessParams,
  CatalogServiceParams,
} from "./catalog.schema.js";
import type { CatalogService } from "./catalog.service.js";

export class CatalogController {
  public constructor(private readonly catalogService: CatalogService) {}

  public getBusinessCatalog = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as CatalogBusinessParams;
    const catalog = await this.catalogService.getBusinessCatalog(params.businessId);
    sendSuccess(response, 200, "Business catalog", catalog);
  };

  public listServiceAddons = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as CatalogServiceParams;
    const addons = await this.catalogService.listServiceAddons(params.businessId, params.serviceId);
    sendSuccess(response, 200, "Service add-ons", { addons });
  };

  public getServiceAvailability = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as CatalogServiceParams;
    const query = request.validated?.query as CatalogAvailabilityQuery;

    const result = await this.catalogService.getServiceAvailability(
      params.businessId,
      params.serviceId,
      query,
    );

    sendSuccess(response, 200, "Availability", result);
  };
}
