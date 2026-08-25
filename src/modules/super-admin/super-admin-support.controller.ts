import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type {
  ChangeSupportTicketStatusBody,
  ListAdminSupportTicketsQuery,
  ListSupportMessagesQuery,
  SupportMessageBody,
  SupportTicketIdParams,
} from "../support/support.schema.js";
import type { SuperAdminSupportService } from "./super-admin-support.service.js";

/** Mounted under `/super-admin`, gated end-to-end by the router-wide `requireRoles(["SUPER_ADMIN"])`
 * gate (see super-admin.route.ts) — same precedent as every other Super Admin controller. */
export class SuperAdminSupportController {
  public constructor(private readonly service: SuperAdminSupportService) {}

  public list = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as ListAdminSupportTicketsQuery;
    const result = await this.service.list(
      { status: query.status, q: query.q },
      { page: query.page, limit: query.limit },
    );
    sendSuccess(response, 200, "Support tickets", result);
  };

  public getById = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as SupportTicketIdParams;
    const ticket = await this.service.getById(params.ticketId);
    sendSuccess(response, 200, "Support ticket", ticket);
  };

  public listMessages = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as SupportTicketIdParams;
    const query = request.validated?.query as ListSupportMessagesQuery;
    const result = await this.service.listMessages(params.ticketId, {
      page: query.page,
      limit: query.limit,
    });
    sendSuccess(response, 200, "Support ticket conversation", result);
  };

  public reply = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as SupportTicketIdParams;
    const body = request.validated?.body as SupportMessageBody;
    const actorUserId = this.requireActorId(request);

    const message = await this.service.reply(params.ticketId, actorUserId, body.message);
    sendSuccess(response, 201, "Reply sent", message);
  };

  public changeStatus = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as SupportTicketIdParams;
    const body = request.validated?.body as ChangeSupportTicketStatusBody;
    const actorUserId = this.requireActorId(request);

    const ticket = await this.service.changeStatus(params.ticketId, actorUserId, body.status);
    sendSuccess(response, 200, "Support ticket status updated", ticket);
  };

  public reopen = async (request: Request, response: Response): Promise<void> => {
    const params = request.validated?.params as SupportTicketIdParams;
    const actorUserId = this.requireActorId(request);

    const ticket = await this.service.reopen(params.ticketId, actorUserId);
    sendSuccess(response, 200, "Support ticket reopened", ticket);
  };

  private requireActorId(request: Request): string {
    if (!request.auth?.userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }
    return request.auth.userId;
  }
}
