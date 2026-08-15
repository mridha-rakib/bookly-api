import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type {
  CreateStaffBody,
  CreateStaffTimeOffBody,
  PutStaffScheduleBody,
  StaffBusinessParams,
  StaffIdParams,
  StaffTimeOffParams,
  UpdateStaffBody,
} from "./staff.schema.js";
import type { StaffService } from "./staff.service.js";

export class StaffController {
  public constructor(private readonly staffService: StaffService) {}

  public list = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as StaffBusinessParams;
    const result = await this.staffService.listStaff(userId, params.businessId);
    sendSuccess(response, 200, "Staff list", result);
  };

  public create = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as StaffBusinessParams;
    const body = request.validated?.body as CreateStaffBody;
    const result = await this.staffService.createStaff(userId, params.businessId, body);
    sendSuccess(response, 201, "Staff member created", result);
  };

  public update = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as StaffIdParams;
    const body = request.validated?.body as UpdateStaffBody;
    const result = await this.staffService.updateStaff(
      userId,
      params.businessId,
      params.staffId,
      body,
    );
    sendSuccess(response, 200, "Staff member updated", result);
  };

  public remove = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as StaffIdParams;
    await this.staffService.removeStaff(userId, params.businessId, params.staffId);
    sendSuccess(response, 200, "Staff member removed");
  };

  public getSchedule = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as StaffIdParams;
    const result = await this.staffService.getSchedule(userId, params.businessId, params.staffId);
    sendSuccess(response, 200, "Staff schedule", result);
  };

  public putSchedule = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as StaffIdParams;
    const body = request.validated?.body as PutStaffScheduleBody;
    const result = await this.staffService.putSchedule(
      userId,
      params.businessId,
      params.staffId,
      body,
    );
    sendSuccess(response, 200, "Staff schedule updated", result);
  };

  public listTimeOff = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as StaffIdParams;
    const result = await this.staffService.listTimeOff(userId, params.businessId, params.staffId);
    sendSuccess(response, 200, "Staff time off", result);
  };

  public createTimeOff = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as StaffIdParams;
    const body = request.validated?.body as CreateStaffTimeOffBody;
    const result = await this.staffService.createTimeOff(
      userId,
      params.businessId,
      params.staffId,
      body,
    );
    sendSuccess(response, 201, "Time off added", result);
  };

  public removeTimeOff = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as StaffTimeOffParams;
    await this.staffService.removeTimeOff(
      userId,
      params.businessId,
      params.staffId,
      params.timeOffId,
    );
    sendSuccess(response, 200, "Time off removed");
  };

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return userId;
  }
}
