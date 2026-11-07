import type { Request, Response } from "express";
import type { z } from "zod";

import { sendSuccess } from "../../common/http/responses.js";
import type {
  SuperAdminListCustomersQuery,
  SuperAdminUserIdParams,
  superAdminCustomerDetailQuerySchema,
} from "./super-admin.schema.js";
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
