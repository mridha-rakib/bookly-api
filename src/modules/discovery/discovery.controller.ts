import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import type { ListDiscoveryBusinessesQuery } from "./discovery.schema.js";
import type { DiscoveryService } from "./discovery.service.js";

/** Public (no `authenticate` anywhere in the chain — see discovery.route.ts) Explore endpoints.
 * Matches the current product: Explore is browsable while logged out (confirmed by investigation
 * — nothing on this route gates browsing behind login, per confirmed rule "do not unnecessarily
 * require login merely to browse public Businesses"). */
export class DiscoveryController {
  public constructor(private readonly discoveryService: DiscoveryService) {}

  public search = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as ListDiscoveryBusinessesQuery;

    const result = await this.discoveryService.search(
      {
        q: query.q,
        city: query.city,
        visitType: query.visitType,
        category: query.category,
        minRating: query.minRating,
      },
      query.sort,
      { page: query.page, limit: query.limit },
    );

    sendSuccess(response, 200, "Businesses", result);
  };

  public listCategories = async (_request: Request, response: Response): Promise<void> => {
    const categories = await this.discoveryService.listCategories();
    sendSuccess(response, 200, "Categories", { categories });
  };
}
