import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type {
  SuperAdminBusinessIdParams,
  SuperAdminListBusinessesQuery,
  SuperAdminRejectBusinessBody,
  SuperAdminSetFoundingPartnerBody,
  SuperAdminSuspendBusinessBody,
} from "./super-admin.schema.js";
import type { SuperAdminBusinessService } from "./super-admin-business.service.js";

/** Mounted under `/super-admin`, gated end-to-end by `requireRoles(["SUPER_ADMIN"])` — same
 * router-wide-gate precedent as SuperAdminFinanceController. Every write action requires
 * `request.auth.userId` (the acting Super Admin) for the statusHistory audit trail. */
export class SuperAdminBusinessController {
  public constructor(private readonly service: SuperAdminBusinessService) {}

  public list = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as SuperAdminListBusinessesQuery;
    const result = await this.service.list(
      {
        status: query.status,
        visitType: query.visitType,
        city: query.city,
        category: query.category,
        q: query.q,
      },
      { page: query.page, limit: query.limit },
    );
    sendSuccess(response, 200, "Businesses", result);
  };

  public getById = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as SuperAdminBusinessIdParams;
    const business = await this.service.getDetail(params.businessId);
    sendSuccess(response, 200, "Business", business);
  };

  public approve = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as SuperAdminBusinessIdParams;
    const superAdminUserId = this.requireActorId(request);
    const business = await this.service.approve(superAdminUserId, params.businessId);
    sendSuccess(response, 200, "Business approved", business);
  };

  public reject = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as SuperAdminBusinessIdParams;
    const body = request.validated?.body as SuperAdminRejectBusinessBody;
    const superAdminUserId = this.requireActorId(request);
    const business = await this.service.reject(superAdminUserId, params.businessId, body.reason);
    sendSuccess(response, 200, "Business rejected", business);
  };

  public suspend = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as SuperAdminBusinessIdParams;
    const body = request.validated?.body as SuperAdminSuspendBusinessBody;
    const superAdminUserId = this.requireActorId(request);
    const business = await this.service.suspend(superAdminUserId, params.businessId, body.reason);
    sendSuccess(response, 200, "Business suspended", business);
  };

  public setFoundingPartner = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as SuperAdminBusinessIdParams;
    const body = request.validated?.body as SuperAdminSetFoundingPartnerBody;
    // Router-wide requireRoles(["SUPER_ADMIN"]) already gates this; requireActorId keeps the
    // same "a write must have an acting Super Admin" invariant as the lifecycle actions.
    this.requireActorId(request);
    const business = await this.service.setFoundingPartner(
      params.businessId,
      body.isFoundingPartner,
    );
    sendSuccess(response, 200, "Business founding partner updated", business);
  };

  private requireActorId(request: Request): string {
    if (!request.auth?.userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }
    return request.auth.userId;
  }
}
