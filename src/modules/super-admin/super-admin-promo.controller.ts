import type { Request, Response } from "express";
import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type { FinanceSummaryQuery } from "../finance/finance.schema.js";
import type {
  CreatePromoBody,
  ListPromoRedemptionsQuery,
  ListPromosQuery,
  PromoIdParams,
  SetPromoStatusBody,
  UpdatePromoBody,
} from "../promo/promo.schema.js";
import type { SuperAdminPromoService } from "./super-admin-promo.service.js";

/** Mounted under `/super-admin`, gated end-to-end by `requireRoles(["SUPER_ADMIN"])` — same
 * router-wide-gate precedent as every other Super Admin controller. Promo Codes are
 * SUPER_ADMIN-only, full stop — no Business-scoped variant of any of these routes exists. */
export class SuperAdminPromoController {
  public constructor(private readonly service: SuperAdminPromoService) {}

  public list = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as ListPromosQuery;
    const result = await this.service.list(
      { status: query.status, q: query.q },
      { page: query.page, limit: query.limit },
    );
    sendSuccess(response, 200, "Promo codes", result);
  };

  public getById = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as PromoIdParams;
    const promo = await this.service.getById(params.promoId);
    sendSuccess(response, 200, "Promo code", promo);
  };

  public create = async (request: Request, response: Response): Promise<void> => {
    const body = request.validated?.body as CreatePromoBody;
    const superAdminUserId = this.requireActorId(request);
    const promo = await this.service.create(superAdminUserId, body);
    sendSuccess(response, 201, "Promo code created", promo);
  };

  public update = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as PromoIdParams;
    const body = request.validated?.body as UpdatePromoBody;
    const promo = await this.service.update(params.promoId, body);
    sendSuccess(response, 200, "Promo code updated", promo);
  };

  public setStatus = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as PromoIdParams;
    const body = request.validated?.body as SetPromoStatusBody;
    const promo = await this.service.setStatus(params.promoId, body.status);
    sendSuccess(response, 200, "Promo code status updated", promo);
  };

  public deletePromo = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as PromoIdParams;
    const result = await this.service.delete(params.promoId);
    sendSuccess(
      response,
      200,
      result.outcome === "deleted"
        ? "Promo code deleted"
        : "Promo code has redemption history — deactivated instead of deleted",
      result,
    );
  };

  public getDiscountedMoney = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as FinanceSummaryQuery;
    const result = await this.service.getDiscountedMoney({ from: query.from, to: query.to });
    sendSuccess(response, 200, "Promo discounted money", result);
  };

  public listRedemptions = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as PromoIdParams;
    const query = request.validated?.query as ListPromoRedemptionsQuery;
    const result = await this.service.listRedemptions(params.promoId, {
      page: query.page,
      limit: query.limit,
    });
    sendSuccess(response, 200, "Promo code usage log", result);
  };

  private requireActorId(request: Request): string {
    if (!request.auth?.userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }
    return request.auth.userId;
  }
}
