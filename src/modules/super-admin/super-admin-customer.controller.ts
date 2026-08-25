import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import type { SuperAdminListCustomersQuery, SuperAdminUserIdParams } from "./super-admin.schema.js";
import type { SuperAdminCustomerService } from "./super-admin-customer.service.js";

export class SuperAdminCustomerController {
  public constructor(private readonly service: SuperAdminCustomerService) {}

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
    const customer = await this.service.getDetail(params.userId);
    sendSuccess(response, 200, "Customer", customer);
  };
}
