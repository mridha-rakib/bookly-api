import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import { toRequesterTicketDto, toSupportMessageDto } from "./support.dto.js";
import type {
  CreateSupportTicketBody,
  ListSupportMessagesQuery,
  ListSupportTicketsQuery,
  SupportMessageBody,
  SupportTicketIdParams,
} from "./support.schema.js";
import type { SupportService } from "./support.service.js";

/** Requester-facing (CUSTOMER/BUSINESS_OWNER/SUPERVISOR/STAFF) Support endpoints, mounted under
 * `/me` — see support.route.ts. */
export class SupportController {
  public constructor(private readonly supportService: SupportService) {}

  public create = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireActor(request);
    const body = request.validated?.body as CreateSupportTicketBody;

    const ticket = await this.supportService.createTicket(userId, role, {
      subject: body.subject,
      message: body.message,
      bookingId: body.bookingId,
    });

    sendSuccess(response, 201, "Support ticket created", toRequesterTicketDto(ticket));
  };

  public list = async (request: Request, response: Response): Promise<void> => {
    const { userId } = this.requireActor(request);
    const query = request.validated?.query as ListSupportTicketsQuery;

    const result = await this.supportService.listOwnTickets(userId, {
      page: query.page,
      limit: query.limit,
    });

    sendSuccess(response, 200, "Support tickets", {
      tickets: result.tickets.map(toRequesterTicketDto),
      pagination: { page: query.page, limit: query.limit, total: result.total },
    });
  };

  public getById = async (request: Request, response: Response): Promise<void> => {
    const { userId } = this.requireActor(request);
    const params = request.validated?.params as SupportTicketIdParams;

    const ticket = await this.supportService.getOwnTicket(params.ticketId, userId);

    sendSuccess(response, 200, "Support ticket", toRequesterTicketDto(ticket));
  };

  public listMessages = async (request: Request, response: Response): Promise<void> => {
    const { userId } = this.requireActor(request);
    const params = request.validated?.params as SupportTicketIdParams;
    const query = request.validated?.query as ListSupportMessagesQuery;

    const result = await this.supportService.listOwnMessages(params.ticketId, userId, {
      page: query.page,
      limit: query.limit,
    });

    sendSuccess(response, 200, "Support ticket conversation", {
      messages: result.messages.map(toSupportMessageDto),
      pagination: { page: query.page, limit: query.limit, total: result.total },
    });
  };

  public reply = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireActor(request);
    const params = request.validated?.params as SupportTicketIdParams;
    const body = request.validated?.body as SupportMessageBody;

    const message = await this.supportService.replyAsRequester(
      params.ticketId,
      userId,
      role,
      body.message,
    );

    sendSuccess(response, 201, "Reply sent", toSupportMessageDto(message));
  };

  public reopen = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireActor(request);
    const params = request.validated?.params as SupportTicketIdParams;

    const ticket = await this.supportService.reopenOwnTicket(params.ticketId, userId, role);

    sendSuccess(response, 200, "Support ticket reopened", toRequesterTicketDto(ticket));
  };

  private requireActor(request: Request): {
    userId: string;
    role: NonNullable<Request["auth"]>["role"];
  } {
    const userId = request.auth?.userId;
    const role = request.auth?.role;
    if (!userId || !role) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }
    return { userId, role };
  }
}
