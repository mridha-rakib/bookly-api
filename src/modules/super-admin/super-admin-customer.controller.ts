import type { Request, Response } from "express";
import type { z } from "zod";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type {
  SuperAdminCustomerStatusBody,
  SuperAdminListCustomersQuery,
  SuperAdminUserIdParams,
  superAdminCustomerDetailQuerySchema,
} from "./super-admin.schema.js";
import type { SuperAdminCustomerService } from "./super-admin-customer.service.js";
import type {
  CustomerStatusActor,
  SuperAdminCustomerStatusService,
} from "./super-admin-customer-status.service.js";

export class SuperAdminCustomerController {
  public constructor(
    private readonly service: SuperAdminCustomerService,
    private readonly statusService?: SuperAdminCustomerStatusService,
  ) {}

  /** P2.2.6 — POST /super-admin/customers/:userId/suspend */
  public suspend = async (request: Request, response: Response): Promise<void> => {
    const result = await this.requireStatusService().suspend(
      this.requireActor(request),
      this.customerId(request),
      this.statusInput(request),
    );
    sendSuccess(
      response,
      200,
      result.changed ? "Customer suspended" : "Customer already suspended",
      result,
    );
  };

  /** P2.2.6 — POST /super-admin/customers/:userId/reactivate */
  public reactivate = async (request: Request, response: Response): Promise<void> => {
    const result = await this.requireStatusService().reactivate(
      this.requireActor(request),
      this.customerId(request),
      this.statusInput(request),
    );
    sendSuccess(
      response,
      200,
      result.changed ? "Customer reactivated" : "Customer already active",
      result,
    );
  };

  private customerId(request: Request): string {
    const params = request.validated?.params as SuperAdminUserIdParams;
    return params.userId;
  }

  private statusInput(request: Request) {
    const body = (request.validated?.body ?? {}) as SuperAdminCustomerStatusBody;
    return {
      reason: body.reason,
      requestId: typeof request.id === "string" && request.id ? request.id : undefined,
    };
  }

  private requireActor(request: Request): CustomerStatusActor {
    if (!request.auth?.userId) throw new AuthError("SESSION_EXPIRED", 401);
    return { userId: request.auth.userId, role: request.auth.role };
  }

  private requireStatusService(): SuperAdminCustomerStatusService {
    if (!this.statusService) throw new Error("Customer status service is not configured");
    return this.statusService;
  }

  public list = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as SuperAdminListCustomersQuery;
    const result = await this.service.list(
      { status: query.status, q: query.q },
      { page: query.page, limit: query.limit },
    );
    sendSuccess(response, 200, "Customers", result);
  };

  public getById = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as SuperAdminUserIdParams;
    const query = request.validated?.query as z.infer<typeof superAdminCustomerDetailQuerySchema>;
    const customer = await this.service.getDetail(params.userId, query);
    sendSuccess(response, 200, "Customer", customer);
  };

  public exportCustomers = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as SuperAdminListCustomersQuery;
    sendSuccess(
      response,
      200,
      "Customer CSV",
      await this.service.exportCustomers({ status: query.status, q: query.q }),
    );
  };

  public exportBookings = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as SuperAdminUserIdParams;
    sendSuccess(
      response,
      200,
      "Booking history CSV",
      await this.service.exportBookings(params.userId),
    );
  };
}
