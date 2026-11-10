import type { Request, Response } from "express";
import { Types } from "mongoose";

import { sendSuccess } from "../../common/http/responses.js";
import type { HomeSectionsQuery, ListDiscoveryBusinessesQuery } from "./discovery.schema.js";
import type { DiscoveryService } from "./discovery.service.js";

/** Public (no `authenticate` anywhere in the chain — see discovery.route.ts) Explore endpoints.
 * Matches the current product: Explore is browsable while logged out (confirmed by investigation
 * — nothing on this route gates browsing behind login, per confirmed rule "do not unnecessarily
 * require login merely to browse public Businesses"). */
export class DiscoveryController {
  public constructor(private readonly discoveryService: DiscoveryService) {}

  public search = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as ListDiscoveryBusinessesQuery;

    // P2.2.3 — optional auth: only a signed-in CUSTOMER's own history personalizes
    // `sort=recommended`; every other caller gets the public ranking.
    const auth = request.auth;
    const customerUserId =
      auth?.role === "CUSTOMER" && Types.ObjectId.isValid(auth.userId)
        ? new Types.ObjectId(auth.userId)
        : undefined;

    const result = await this.discoveryService.search(
      {
        q: query.q,
        city: query.city,
        visitType: query.visitType,
        category: query.category,
        minRating: query.minRating,
        origin: query.origin,
        radiusKm: query.radiusKm,
      },
      query.sort,
      { page: query.page, limit: query.limit },
      { customerUserId, availability: query.availability },
    );
    // Personalized and location-dependent results must never be shared by caches.
    if (customerUserId || query.origin) response.setHeader("Cache-Control", "private, no-store");

    sendSuccess(response, 200, "Businesses", result);
  };

  /** Public, OPTIONALLY authenticated (see discovery.route.ts) — the homepage's Recommended /
   * Services near you / Popular rows. A logged-in CUSTOMER's `req.auth` personalizes only
   * "Recommended"; every other caller gets an honest non-personalized ranking. */
  public homeSections = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as HomeSectionsQuery;
    const auth = request.auth;
    const customerUserId =
      auth?.role === "CUSTOMER" && Types.ObjectId.isValid(auth.userId)
        ? new Types.ObjectId(auth.userId)
        : undefined;

    const result = await this.discoveryService.getHomeSections({
      city: query.city,
      contextCategories: query.category,
      customerUserId,
      limit: query.limit,
    });

    sendSuccess(response, 200, "Home sections", result);
  };

  public listCategories = async (_request: Request, response: Response): Promise<void> => {
    const categories = await this.discoveryService.listCategories();
    sendSuccess(response, 200, "Categories", { categories });
  };

  public listFoundingPartners = async (_request: Request, response: Response): Promise<void> => {
    const businesses = await this.discoveryService.listFoundingPartners();
    sendSuccess(response, 200, "Founding partners", { businesses });
  };
}
