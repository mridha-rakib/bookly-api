import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type { BookingService } from "../booking/booking.service.js";
import type { AvailabilityParams, GetAvailabilityQuery } from "./availability.schema.js";
import type { AvailabilityService } from "./availability.service.js";
import { ANY_STAFF } from "./availability.types.js";

export class AvailabilityController {
  public constructor(
    private readonly availabilityService: AvailabilityService,
    // Reused rather than re-implemented — see BookingService.requireBookingManagementAccess's
    // own doc comment (Owner-or-active-Supervisor, business-scoped, anti-enumeration 404s).
    // Availability has no independent authorization surface of its own in this batch; a real
    // customer-facing/public read path is explicit Batch 3/frontend-integration scope (see the
    // Batch 2 final report).
    private readonly bookingService: BookingService,
  ) {}

  public get = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const role = this.requireRole(request);
    const params = request.validated?.params as AvailabilityParams;
    const query = request.validated?.query as GetAvailabilityQuery;

    await this.bookingService.requireBookingManagementAccess(userId, role, params.businessId);

    const result = await this.availabilityService.getAvailability({
      businessId: params.businessId,
      serviceId: params.serviceId,
      staffMembershipId:
        query.staffMembershipId === ANY_STAFF ? undefined : query.staffMembershipId,
      fromDate: query.fromDate,
      toDate: query.toDate,
      partySize: query.partySize,
      customerCity: query.customerCity,
    });

    sendSuccess(response, 200, "Availability", result);
  };

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return userId;
  }

  private requireRole(request: Request): "BUSINESS_OWNER" | "SUPERVISOR" {
    const role = request.auth?.role;

    if (role !== "BUSINESS_OWNER" && role !== "SUPERVISOR") {
      throw new AuthError("PORTAL_MISMATCH", 403);
    }

    return role;
  }
}
