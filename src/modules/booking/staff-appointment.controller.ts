import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type { StaffAppointmentListQueryInput } from "./staff-appointment.schema.js";
import type { StaffAppointmentService } from "./staff-appointment.service.js";

/** P4C-1 — read-only. The actor is always the authenticated session user. */
export class StaffAppointmentController {
  public constructor(
    private readonly service: Pick<
      StaffAppointmentService,
      "listMyAppointments" | "getMyAppointment"
    >,
  ) {}

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;
    if (!userId) throw new AuthError("SESSION_EXPIRED", 401);
    return userId;
  }

  public list = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as { businessId: string };
    const query = request.validated?.query as unknown as StaffAppointmentListQueryInput;
    const result = await this.service.listMyAppointments(userId, params.businessId, query);
    sendSuccess(response, 200, "My appointments", result);
  };

  public get = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as { businessId: string; bookingId: string };
    const result = await this.service.getMyAppointment(userId, params.businessId, params.bookingId);
    sendSuccess(response, 200, "Appointment", result);
  };
}
