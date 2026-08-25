import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type { FavoriteBusinessIdParams, ListFavoritesQuery } from "./favorite.schema.js";
import type { FavoriteService } from "./favorite.service.js";

/** Mounted under `/me`, CUSTOMER-authenticated (see favorite.route.ts) — matches every other
 * self-service Customer surface in this codebase (Bookings, Reviews, Support). */
export class FavoriteController {
  public constructor(private readonly favoriteService: FavoriteService) {}

  public add = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const params = request.validated?.params as FavoriteBusinessIdParams;

    await this.favoriteService.add(userId, params.businessId);

    sendSuccess(response, 200, "Business favorited");
  };

  public remove = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const params = request.validated?.params as FavoriteBusinessIdParams;

    await this.favoriteService.remove(userId, params.businessId);

    sendSuccess(response, 200, "Business unfavorited");
  };

  public listIds = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);

    const businessIds = await this.favoriteService.listBusinessIds(userId);

    sendSuccess(response, 200, "Favorite business ids", { businessIds });
  };

  public list = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const query = request.validated?.query as ListFavoritesQuery;

    const result = await this.favoriteService.list(userId, {
      page: query.page,
      limit: query.limit,
    });

    sendSuccess(response, 200, "Favorites", result);
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
