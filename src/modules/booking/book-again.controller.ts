import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type { BookAgainService } from "./book-again.service.js";
import type { ListCustomerBookingsQuery } from "./booking.schema.js";

/** Mounted under `/me` alongside the rest of the Customer booking surface (see
 * createCustomerBookingRoute in booking.route.ts) — reuses the exact same pagination query shape
 * as `GET /me/bookings`. */
export class BookAgainController {
  public constructor(private readonly bookAgainService: BookAgainService) {}

  public list = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const query = request.validated?.query as ListCustomerBookingsQuery;

    const result = await this.bookAgainService.listCandidates(userId, {
      page: query.page,
      limit: query.limit,
      sortDirection: -1,
    });

    sendSuccess(response, 200, "Book again", result);
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
