import { Types } from "mongoose";

import { logger } from "../../config/logger.js";
import type { BookingRepository } from "../booking/booking.repository.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { StaffRepository } from "../staff/staff.repository.js";
import type { UserRepository } from "../user/user.repository.js";
import type { UserRole } from "../user/user.types.js";
import { SupportError } from "./support.errors.js";
import {
  SUPPORT_REOPENABLE_FROM,
  SUPPORT_STATUS_TRANSITIONS,
  type SupportTicketRequesterRole,
  type SupportTicketStatus,
  supportTicketRequesterRoles,
} from "./support.types.js";
import type { SupportEmailProvider } from "./support-email.provider.js";
import type { SupportMessageDocument } from "./support-message.model.js";
import type { SupportMessageRepository } from "./support-message.repository.js";
import type { SupportTicketDocument } from "./support-ticket.model.js";
import type {
  SupportTicketPagination,
  SupportTicketRepository,
} from "./support-ticket.repository.js";

export type CreateSupportTicketWriteInput = {
  subject: string;
  message: string;
  bookingId?: string | undefined;
};

/**
 * Batch 15B — the core Support domain service, shared by both the requester-facing controller
 * (mounted at `/me`) and the Super Admin controller (mounted at `/super-admin`). Every write path
 * re-derives requesterUserId/requesterRole/businessId from the authenticated actor — nothing here
 * ever trusts a client-submitted value for any of those three fields (confirmed rule).
 *
 * "My Tickets" is uniformly requesterUserId-scoped for all four roles (Q2) — there is no
 * shared-per-Business inbox in this batch; a BUSINESS_OWNER cannot see a SUPERVISOR's tickets for
 * the same Business, and vice versa. This is the simplest model the confirmed rules support and
 * mirrors Review's own single-owner Customer scoping, generalized to four roles instead of one.
 */
export class SupportService {
  public constructor(
    private readonly ticketRepository: SupportTicketRepository,
    private readonly messageRepository: SupportMessageRepository,
    private readonly bookingRepository: BookingRepository,
    private readonly businessRepository: BusinessRepository,
    private readonly staffRepository: StaffRepository,
    private readonly userRepository: UserRepository,
    private readonly emailProvider: SupportEmailProvider,
  ) {}

  // --- Requester-side -------------------------------------------------------------------------

  public async createTicket(
    actorUserId: string,
    actorRole: UserRole,
    input: CreateSupportTicketWriteInput,
  ): Promise<SupportTicketDocument> {
    const requesterRole = this.requireSupportedRole(actorRole);
    const businessId = await this.resolveBusinessContext(actorUserId, requesterRole);
    const bookingId = input.bookingId
      ? await this.verifyBookingLinkage(input.bookingId, actorUserId, requesterRole, businessId)
      : undefined;

    const requesterObjectId = new Types.ObjectId(actorUserId);
    const ticket = await this.ticketRepository.create({
      requesterUserId: requesterObjectId,
      requesterRole,
      businessId,
      bookingId,
      subject: input.subject,
      historyEntry: {
        action: "CREATED",
        actorUserId: requesterObjectId,
        actorRole,
        previousStatus: null,
        resultingStatus: "OPEN",
        createdAt: new Date(),
      },
    });

    await this.messageRepository.create({
      ticketId: ticket._id,
      senderUserId: requesterObjectId,
      senderRole: actorRole,
      message: input.message,
    });

    await this.sendTicketCreatedEmail(ticket, actorUserId);

    return ticket;
  }

  public async listOwnTickets(
    actorUserId: string,
    pagination: SupportTicketPagination,
  ): Promise<{ tickets: SupportTicketDocument[]; total: number }> {
    return this.ticketRepository.listByRequester(actorUserId, pagination);
  }

  public async getOwnTicket(ticketId: string, actorUserId: string): Promise<SupportTicketDocument> {
    return this.requireOwnedTicket(ticketId, actorUserId);
  }

  public async listOwnMessages(
    ticketId: string,
    actorUserId: string,
    pagination: SupportTicketPagination,
  ): Promise<{ messages: SupportMessageDocument[]; total: number }> {
    const ticket = await this.requireOwnedTicket(ticketId, actorUserId);
    return this.messageRepository.listByTicketId(ticket._id, pagination);
  }

  public async replyAsRequester(
    ticketId: string,
    actorUserId: string,
    actorRole: UserRole,
    message: string,
  ): Promise<SupportMessageDocument> {
    const ticket = await this.requireOwnedTicket(ticketId, actorUserId);
    this.requireReplyable(ticket);

    return this.messageRepository.create({
      ticketId: ticket._id,
      senderUserId: new Types.ObjectId(actorUserId),
      senderRole: actorRole,
      message,
    });
  }

  public async reopenOwnTicket(
    ticketId: string,
    actorUserId: string,
    actorRole: UserRole,
  ): Promise<SupportTicketDocument> {
    const ticket = await this.requireOwnedTicket(ticketId, actorUserId);
    return this.reopen(ticket, actorUserId, actorRole);
  }

  // --- Super Admin ------------------------------------------------------------------------------

  public async listForAdmin(
    filter: { status?: SupportTicketStatus | undefined; q?: string | undefined },
    pagination: SupportTicketPagination,
  ): Promise<{ tickets: SupportTicketDocument[]; total: number }> {
    return this.ticketRepository.listForAdmin(filter, pagination);
  }

  public async getForAdmin(ticketId: string): Promise<SupportTicketDocument> {
    return this.requireTicket(ticketId);
  }

  public async listMessagesForAdmin(
    ticketId: string,
    pagination: SupportTicketPagination,
  ): Promise<{ messages: SupportMessageDocument[]; total: number }> {
    const ticket = await this.requireTicket(ticketId);
    return this.messageRepository.listByTicketId(ticket._id, pagination);
  }

  public async replyAsAdmin(
    ticketId: string,
    adminUserId: string,
    message: string,
  ): Promise<SupportMessageDocument> {
    const ticket = await this.requireTicket(ticketId);
    this.requireReplyable(ticket);

    const created = await this.messageRepository.create({
      ticketId: ticket._id,
      senderUserId: new Types.ObjectId(adminUserId),
      senderRole: "SUPER_ADMIN",
      message,
    });

    await this.sendAdminReplyEmail(ticket);

    return created;
  }

  /** Regular (non-Reopen) admin-driven status change — validated against the centralized
   * transition table BEFORE ever touching the database, then re-verified atomically via CAS (see
   * support.types.ts's own comment on the exact graph). */
  public async changeStatus(
    ticketId: string,
    adminUserId: string,
    toStatus: SupportTicketStatus,
  ): Promise<SupportTicketDocument> {
    const ticket = await this.requireTicket(ticketId);
    const allowed = SUPPORT_STATUS_TRANSITIONS[ticket.status];
    if (!allowed.includes(toStatus)) {
      throw new SupportError("SUPPORT_INVALID_STATUS_TRANSITION", 409);
    }

    const updated = await this.ticketRepository.transitionStatus(
      ticket._id,
      [ticket.status],
      toStatus,
      {
        action: "STATUS_CHANGED",
        actorUserId: new Types.ObjectId(adminUserId),
        actorRole: "SUPER_ADMIN",
        previousStatus: ticket.status,
        resultingStatus: toStatus,
        createdAt: new Date(),
      },
    );
    if (!updated) {
      // Lost a concurrent race — the ticket is no longer in the status this request assumed.
      throw new SupportError("SUPPORT_INVALID_STATUS_TRANSITION", 409);
    }
    return updated;
  }

  public async reopenAsAdmin(
    ticketId: string,
    adminUserId: string,
  ): Promise<SupportTicketDocument> {
    const ticket = await this.requireTicket(ticketId);
    return this.reopen(ticket, adminUserId, "SUPER_ADMIN");
  }

  // --- Internal ---------------------------------------------------------------------------------

  private requireSupportedRole(role: UserRole): SupportTicketRequesterRole {
    if (!(supportTicketRequesterRoles as readonly string[]).includes(role)) {
      throw new SupportError("SUPPORT_TICKET_NOT_FOUND", 404);
    }
    return role as SupportTicketRequesterRole;
  }

  /** BUSINESS_OWNER/SUPERVISOR/STAFF each resolve to exactly one Business via the SAME real
   * ownership/membership primitives `BookingService.requireBookingManagementAccess` already
   * established — never a client-submitted businessId. CUSTOMER never has a Business context. */
  private async resolveBusinessContext(
    actorUserId: string,
    requesterRole: SupportTicketRequesterRole,
  ): Promise<Types.ObjectId | undefined> {
    if (requesterRole === "CUSTOMER") {
      return undefined;
    }

    if (requesterRole === "BUSINESS_OWNER") {
      const business = await this.businessRepository.findByOwnerUserId(actorUserId);
      if (!business) {
        throw new SupportError("SUPPORT_BUSINESS_CONTEXT_UNAVAILABLE", 400);
      }
      return business._id;
    }

    // SUPERVISOR | STAFF
    const membership = await this.staffRepository.findActiveByUserId(actorUserId);
    if (!membership || membership.role !== requesterRole) {
      throw new SupportError("SUPPORT_BUSINESS_CONTEXT_UNAVAILABLE", 400);
    }
    return membership.businessId;
  }

  /** Never trusts the submitted bookingId's ownership — re-verifies it server-side through the
   * SAME primitives already used elsewhere: `findByIdForCustomer` for a Customer requester,
   * `findById(businessId, bookingId)` (Business-scoped) for a Business-side requester. A
   * cross-customer or cross-business bookingId is indistinguishable from an unknown one. */
  private async verifyBookingLinkage(
    bookingId: string,
    actorUserId: string,
    requesterRole: SupportTicketRequesterRole,
    businessId: Types.ObjectId | undefined,
  ): Promise<Types.ObjectId> {
    if (!Types.ObjectId.isValid(bookingId)) {
      throw new SupportError("SUPPORT_BOOKING_NOT_FOUND", 404);
    }

    const booking =
      requesterRole === "CUSTOMER"
        ? await this.bookingRepository.findByIdForCustomer(bookingId, actorUserId)
        : businessId
          ? await this.bookingRepository.findById(businessId, bookingId)
          : null;

    if (!booking) {
      throw new SupportError("SUPPORT_BOOKING_NOT_FOUND", 404);
    }
    return booking._id;
  }

  private async requireOwnedTicket(
    ticketId: string,
    actorUserId: string,
  ): Promise<SupportTicketDocument> {
    if (!Types.ObjectId.isValid(ticketId)) {
      throw new SupportError("SUPPORT_TICKET_NOT_FOUND", 404);
    }
    const ticket = await this.ticketRepository.findByIdForRequester(ticketId, actorUserId);
    if (!ticket) {
      throw new SupportError("SUPPORT_TICKET_NOT_FOUND", 404);
    }
    return ticket;
  }

  private async requireTicket(ticketId: string): Promise<SupportTicketDocument> {
    if (!Types.ObjectId.isValid(ticketId)) {
      throw new SupportError("SUPPORT_TICKET_NOT_FOUND", 404);
    }
    const ticket = await this.ticketRepository.findById(ticketId);
    if (!ticket) {
      throw new SupportError("SUPPORT_TICKET_NOT_FOUND", 404);
    }
    return ticket;
  }

  /** OPEN/PENDING only — RESOLVED/CLOSED both require an explicit Reopen first (confirmed rule:
   * never silently auto-reopen a ticket as a side effect of a reply). */
  private requireReplyable(ticket: SupportTicketDocument): void {
    if (ticket.status === "RESOLVED" || ticket.status === "CLOSED") {
      throw new SupportError("SUPPORT_TICKET_REPLY_NOT_ALLOWED", 409);
    }
  }

  private async reopen(
    ticket: SupportTicketDocument,
    actorUserId: string,
    actorRole: UserRole,
  ): Promise<SupportTicketDocument> {
    if (!SUPPORT_REOPENABLE_FROM.includes(ticket.status)) {
      throw new SupportError("SUPPORT_TICKET_REOPEN_NOT_ALLOWED", 409);
    }

    const updated = await this.ticketRepository.transitionStatus(
      ticket._id,
      SUPPORT_REOPENABLE_FROM,
      "OPEN",
      {
        action: "REOPENED",
        actorUserId: new Types.ObjectId(actorUserId),
        actorRole,
        previousStatus: ticket.status,
        resultingStatus: "OPEN",
        createdAt: new Date(),
      },
    );
    if (!updated) {
      throw new SupportError("SUPPORT_TICKET_REOPEN_NOT_ALLOWED", 409);
    }
    return updated;
  }

  // --- Email (best-effort; never fails the surrounding request) --------------------------------

  private async sendTicketCreatedEmail(
    ticket: SupportTicketDocument,
    actorUserId: string,
  ): Promise<void> {
    try {
      const user = await this.userRepository.findById(actorUserId);
      if (!user) {
        return;
      }
      await this.emailProvider.send({
        to: user.normalizedEmail,
        subject: `We received your request — ${ticket.reference}`,
        text: `Thanks for contacting Bookly Support.\n\nTicket reference: ${ticket.reference}\nSubject: ${ticket.subject}\n\nWe've received your request and will get back to you soon.`,
      });
    } catch (error) {
      logger.warn({ error, ticketId: String(ticket._id) }, "Support ticket-created email failed");
    }
  }

  private async sendAdminReplyEmail(ticket: SupportTicketDocument): Promise<void> {
    try {
      const user = await this.userRepository.findById(ticket.requesterUserId);
      if (!user) {
        return;
      }
      await this.emailProvider.send({
        to: user.normalizedEmail,
        subject: `New reply on your Support ticket — ${ticket.reference}`,
        text: `Support has replied to your ticket.\n\nTicket reference: ${ticket.reference}\nSubject: ${ticket.subject}\n\nLog in to Bookly to view the reply and continue the conversation.`,
      });
    } catch (error) {
      logger.warn({ error, ticketId: String(ticket._id) }, "Support admin-reply email failed");
    }
  }
}
