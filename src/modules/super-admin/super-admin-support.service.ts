import type { BookingRepository } from "../booking/booking.repository.js";
import type { BusinessRepository } from "../business/business.repository.js";
import {
  type SuperAdminSupportTicketDetailDto,
  type SuperAdminSupportTicketRowDto,
  type SupportMessageDto,
  toSupportMessageDto,
} from "../support/support.dto.js";
import type { SupportService } from "../support/support.service.js";
import type { SupportTicketStatus } from "../support/support.types.js";
import type { SupportTicketDocument } from "../support/support-ticket.model.js";
import type { UserRepository } from "../user/user.repository.js";

export type SuperAdminSupportListResult = {
  tickets: SuperAdminSupportTicketRowDto[];
  pagination: { page: number; limit: number; total: number };
};

/** Batch 15B — Super Admin Support. Composes the domain `SupportService` (never re-implements
 * lifecycle/CAS logic here) with batched User/UserProfile/Business enrichment — the same "one
 * batched lookup, never N+1" convention SuperAdminReviewService already established. Booking
 * context (item 21) is resolved only at detail-view time, never for the whole list, since it's a
 * per-ticket optional extra, not a list column. */
export class SuperAdminSupportService {
  public constructor(
    private readonly supportService: SupportService,
    private readonly userRepository: UserRepository,
    private readonly businessRepository: BusinessRepository,
    private readonly bookingRepository: BookingRepository,
  ) {}

  public async list(
    filter: { status?: SupportTicketStatus | undefined; q?: string | undefined },
    pagination: { page: number; limit: number },
  ): Promise<SuperAdminSupportListResult> {
    const { tickets, total } = await this.supportService.listForAdmin(filter, pagination);
    const rows = await this.enrichRows(tickets);
    return { tickets: rows, pagination: { page: pagination.page, limit: pagination.limit, total } };
  }

  public async getById(ticketId: string): Promise<SuperAdminSupportTicketDetailDto> {
    const ticket = await this.supportService.getForAdmin(ticketId);
    return this.enrichDetail(ticket);
  }

  public async listMessages(
    ticketId: string,
    pagination: { page: number; limit: number },
  ): Promise<{
    messages: SupportMessageDto[];
    pagination: { page: number; limit: number; total: number };
  }> {
    const result = await this.supportService.listMessagesForAdmin(ticketId, pagination);
    return {
      messages: result.messages.map(toSupportMessageDto),
      pagination: { page: pagination.page, limit: pagination.limit, total: result.total },
    };
  }

  public async reply(
    ticketId: string,
    adminUserId: string,
    message: string,
  ): Promise<SupportMessageDto> {
    const created = await this.supportService.replyAsAdmin(ticketId, adminUserId, message);
    return toSupportMessageDto(created);
  }

  public async changeStatus(
    ticketId: string,
    adminUserId: string,
    status: SupportTicketStatus,
  ): Promise<SuperAdminSupportTicketDetailDto> {
    const ticket = await this.supportService.changeStatus(ticketId, adminUserId, status);
    return this.enrichDetail(ticket);
  }

  public async reopen(
    ticketId: string,
    adminUserId: string,
  ): Promise<SuperAdminSupportTicketDetailDto> {
    const ticket = await this.supportService.reopenAsAdmin(ticketId, adminUserId);
    return this.enrichDetail(ticket);
  }

  // --- Internal -----------------------------------------------------------------------------

  private async enrichRows(
    tickets: SupportTicketDocument[],
  ): Promise<SuperAdminSupportTicketRowDto[]> {
    const requesterUserIds = [...new Set(tickets.map((t) => String(t.requesterUserId)))];
    const businessIds = [
      ...new Set(tickets.filter((t) => t.businessId).map((t) => String(t.businessId))),
    ];

    const [users, profiles, businesses] = await Promise.all([
      this.userRepository.findManyByIds(requesterUserIds),
      this.userRepository.findProfilesByUserIds(requesterUserIds),
      this.businessRepository.findManyByIds(businessIds),
    ]);

    const emailByUserId = new Map(users.map((u) => [String(u._id), u.normalizedEmail]));
    const nameByUserId = new Map(
      profiles.map((p) => [String(p.userId), `${p.firstName} ${p.lastName}`.trim()]),
    );
    const businessNameById = new Map(businesses.map((b) => [String(b._id), b.name]));

    return tickets.map((ticket) =>
      this.toRowDto(ticket, emailByUserId, nameByUserId, businessNameById),
    );
  }

  private async enrichDetail(
    ticket: SupportTicketDocument,
  ): Promise<SuperAdminSupportTicketDetailDto> {
    const [rows] = await Promise.all([this.enrichRows([ticket])]);
    const row = rows[0] as SuperAdminSupportTicketRowDto;

    let bookingReference: string | undefined;
    let bookingStatus: string | undefined;
    if (ticket.bookingId) {
      const [booking] = await this.bookingRepository.findManyByIdsCrossBusiness([ticket.bookingId]);
      bookingReference = booking?.reference;
      bookingStatus = booking?.status;
    }

    return {
      ...row,
      bookingId: ticket.bookingId ? String(ticket.bookingId) : undefined,
      bookingReference,
      bookingStatus,
      statusHistory: ticket.statusHistory.map((entry) => ({
        action: entry.action,
        actorRole: entry.actorRole,
        previousStatus: entry.previousStatus,
        resultingStatus: entry.resultingStatus,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  }

  private toRowDto(
    ticket: SupportTicketDocument,
    emailByUserId: Map<string, string>,
    nameByUserId: Map<string, string>,
    businessNameById: Map<string, string>,
  ): SuperAdminSupportTicketRowDto {
    return {
      id: String(ticket._id),
      reference: ticket.reference,
      subject: ticket.subject,
      status: ticket.status,
      requesterUserId: String(ticket.requesterUserId),
      requesterRole: ticket.requesterRole,
      requesterDisplayName: nameByUserId.get(String(ticket.requesterUserId)) || "—",
      requesterEmail: emailByUserId.get(String(ticket.requesterUserId)) ?? "—",
      businessId: ticket.businessId ? String(ticket.businessId) : undefined,
      businessName: ticket.businessId
        ? (businessNameById.get(String(ticket.businessId)) ?? "—")
        : undefined,
      createdAt: ticket.createdAt.toISOString(),
      updatedAt: ticket.updatedAt.toISOString(),
    };
  }
}
