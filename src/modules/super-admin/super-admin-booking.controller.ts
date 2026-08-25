import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import type {
  SuperAdminBookingIdParams,
  SuperAdminListBookingsQuery,
} from "./super-admin.schema.js";
import type { SuperAdminBookingService } from "./super-admin-booking.service.js";

export class SuperAdminBookingController {
  public constructor(private readonly service: SuperAdminBookingService) {}

  public list = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as SuperAdminListBookingsQuery;
    const result = await this.service.list(
      {
        businessId: query.businessId,
        status: query.status,
        q: query.q,
        fromDate: query.fromDate,
        toDate: query.toDate,
      },
      { page: query.page, limit: query.limit },
    );
    sendSuccess(response, 200, "Bookings", result);
  };

  public getById = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as SuperAdminBookingIdParams;
    const booking = await this.service.getDetail(params.bookingId);
    sendSuccess(response, 200, "Booking", booking);
  };
}
