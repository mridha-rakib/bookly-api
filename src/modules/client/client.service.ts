import { Types } from "mongoose";

import { normalizeEmail, normalizePhoneNumber } from "../auth/auth.utils.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { StaffRepository } from "../staff/staff.repository.js";
import type { UserRepository } from "../user/user.repository.js";
import type { UserRole } from "../user/user.types.js";
import { ClientError } from "./client.errors.js";
import type { BusinessClientAddress, BusinessClientDocument } from "./client.model.js";
import type {
  ClientRepository,
  CreateClientInput,
  UpdateClientBusinessFields,
} from "./client.repository.js";
import type { CreateClientBody, UpdateClientBody } from "./client.schema.js";
import type { ClientLinkState, ClientTag } from "./client.types.js";
import type { ClientIdentityService } from "./client-identity.service.js";

export type BusinessClientDto = {
  id: string;
  businessId: string;
  firstName: string;
  lastName?: string | undefined;
  email: string;
  phone: { countryCode: string; nationalNumber: string; e164: string };
  dateOfBirth?: string | undefined;
  gender?: "male" | "female" | "other" | undefined;
  /** Batch 9 — optional: a Client auto-created for a Customer's first AT_BUSINESS_LOCATION
   * booking has no address on file (see BusinessClientDocument's own doc comment). The
   * Business-owner Clients UI should treat this as "not yet provided," never fabricate one. */
  address?: BusinessClientAddress | undefined;
  notes?: string | undefined;
  tag?: ClientTag | undefined;
  linkState: ClientLinkState;
  /** false only when LINKED — drives the frontend's read-only identity styling. */
  isIdentityEditable: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | undefined;
};

export type ClientListDto = {
  clients: BusinessClientDto[];
  pagination: { page: number; limit: number; total: number };
  /**
   * Only Total/New-this-month are populated here — Active-this-month, At-risk, and Average
   * lifetime value all depend on Booking/Payment history that doesn't exist yet (see report);
   * they are deliberately absent rather than fabricated, and the frontend renders them as a
   * neutral placeholder.
   */
  stats: { totalClients: number; newThisMonth: number };
};

type ListClientsQuery = {
  q?: string | undefined;
  tag?: ClientTag | undefined;
  archived: boolean;
  page: number;
  limit: number;
};

const identityFieldKeys = ["firstName", "lastName", "email", "phone", "gender"] as const;

type NormalizedPhone = ReturnType<typeof normalizePhoneNumber>;

export class ClientService {
  public constructor(
    private readonly clientRepository: ClientRepository,
    private readonly businessRepository: BusinessRepository,
    private readonly staffRepository: StaffRepository,
    private readonly userRepository: UserRepository,
    private readonly clientIdentityService: ClientIdentityService,
  ) {}

  public async listClients(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    query: ListClientsQuery,
  ): Promise<ClientListDto> {
    const business = await this.requireBusinessAccess(actorUserId, actorRole, businessId);

    const [{ clients, total }, stats] = await Promise.all([
      this.clientRepository.listByBusinessId(business._id, {
        archivedOnly: query.archived,
        tag: query.tag,
        q: query.q,
        page: query.page,
        limit: query.limit,
      }),
      this.clientRepository.getStats(business._id),
    ]);

    const dtos = await this.toClientDtos(clients);

    return {
      clients: dtos,
      pagination: { page: query.page, limit: query.limit, total },
      stats: { totalClients: stats.total, newThisMonth: stats.newThisMonth },
    };
  }

  public async getClient(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    clientId: string,
  ): Promise<BusinessClientDto> {
    const business = await this.requireBusinessAccess(actorUserId, actorRole, businessId);
    const client = await this.requireClient(business, clientId);

    const [dto] = await this.toClientDtos([client]);
    return dto as BusinessClientDto;
  }

  public async createClient(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    body: CreateClientBody,
  ): Promise<BusinessClientDto> {
    const business = await this.requireBusinessAccess(actorUserId, actorRole, businessId);

    const normalizedEmail = normalizeEmail(body.email);
    const phone = this.parsePhone(body.phone.countryCode, body.phone.nationalNumber);

    const resolution = await this.clientIdentityService.resolveContactLinkState({
      normalizedEmail,
      phoneE164: phone.e164,
    });

    const input: CreateClientInput = {
      businessId: business._id,
      createdByUserId: new Types.ObjectId(actorUserId),
      firstName: body.firstName,
      lastName: body.lastName,
      normalizedEmail,
      phone,
      dateOfBirth: body.dateOfBirth,
      gender: body.gender,
      address: body.address,
      notes: body.notes,
      tag: body.tag,
      linkState: resolution.linkState,
      linkedUserId: resolution.linkedUserId,
    };

    try {
      const created = await this.clientRepository.create(input);
      const [dto] = await this.toClientDtos([created]);
      return dto as BusinessClientDto;
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        throw this.mapDuplicateKeyError(error);
      }
      throw error;
    }
  }

  public async updateClient(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    clientId: string,
    body: UpdateClientBody,
  ): Promise<BusinessClientDto> {
    const business = await this.requireBusinessAccess(actorUserId, actorRole, businessId);
    const existing = await this.requireClient(business, clientId, { excludeArchived: true });

    const attemptsIdentityChange = identityFieldKeys.some(
      (key) => body[key as keyof UpdateClientBody] !== undefined,
    );

    if (existing.linkState === "LINKED" && attemptsIdentityChange) {
      throw new ClientError("CLIENT_IDENTITY_LOCKED", 409);
    }

    const fields: UpdateClientBusinessFields = {};
    if (body.dateOfBirth !== undefined) fields.dateOfBirth = body.dateOfBirth;
    if (body.address !== undefined) fields.address = body.address;
    if (body.notes !== undefined) fields.notes = body.notes;
    if (body.tag !== undefined) fields.tag = body.tag;

    let newNormalizedEmail: string | undefined;
    let newPhone: NormalizedPhone | undefined;

    // Only reachable when NOT linked (guarded above) — local contact identity stays editable
    // until a real Customer link is established.
    if (attemptsIdentityChange) {
      if (body.firstName !== undefined) fields.firstName = body.firstName;
      if (body.lastName !== undefined) fields.lastName = body.lastName;
      if (body.gender !== undefined) fields.gender = body.gender;

      if (body.email !== undefined) {
        newNormalizedEmail = normalizeEmail(body.email);
        fields.normalizedEmail = newNormalizedEmail;
      }

      if (body.phone !== undefined) {
        newPhone = this.parsePhone(body.phone.countryCode, body.phone.nationalNumber);
        fields.phone = newPhone;
      }
    }

    let updated: BusinessClientDocument | null;
    try {
      updated = await this.clientRepository.updateBusinessFields(business._id, clientId, fields);
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        throw this.mapDuplicateKeyError(error);
      }
      throw error;
    }

    if (!updated) {
      throw new ClientError("CLIENT_NOT_FOUND", 404);
    }

    // Contact identity changed while unlinked — re-run matching, since it may now resolve to a
    // real Customer (or may not); this never touches archivedAt or forces a restore.
    if (newNormalizedEmail !== undefined || newPhone !== undefined) {
      const resolution = await this.clientIdentityService.resolveContactLinkState({
        normalizedEmail: newNormalizedEmail ?? updated.normalizedEmail,
        phoneE164: newPhone?.e164 ?? updated.phone.e164,
      });
      const relinked = await this.clientRepository.setLinkState(updated._id, resolution);
      if (relinked) {
        updated = relinked;
      }
    }

    const [dto] = await this.toClientDtos([updated]);
    return dto as BusinessClientDto;
  }

  public async archiveClient(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    clientId: string,
  ): Promise<void> {
    const business = await this.requireBusinessAccess(actorUserId, actorRole, businessId);
    const existing = await this.requireClient(business, clientId);

    if (existing.archivedAt) {
      throw new ClientError("CLIENT_ALREADY_ARCHIVED", 409);
    }

    await this.clientRepository.archiveById(business._id, clientId);
  }

  public async restoreClient(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    clientId: string,
  ): Promise<BusinessClientDto> {
    const business = await this.requireBusinessAccess(actorUserId, actorRole, businessId);
    const existing = await this.requireClient(business, clientId);

    if (!existing.archivedAt) {
      throw new ClientError("CLIENT_NOT_ARCHIVED", 409);
    }

    // Restoring the Business relationship never touches linkState/linkedUserId — an archived
    // Client may already be LINKED (or become linked while archived, per spec) and restore
    // must not disturb that.
    const restored = await this.clientRepository.restoreById(business._id, clientId);

    if (!restored) {
      throw new ClientError("CLIENT_NOT_FOUND", 404);
    }

    const [dto] = await this.toClientDtos([restored]);
    return dto as BusinessClientDto;
  }

  // --- Authorization --------------------------------------------------------------------

  /**
   * First Supervisor-scoped authorization in the codebase (Staff/Services are Owner-only
   * today). BusinessAccess (linked/secondary Business) is deliberately never consulted here,
   * matching every other management-surface convention. 404 (never a bare 403) on any
   * mismatch so a forged businessId cannot be used to probe for another owner's/business's
   * existence.
   */
  private async requireBusinessAccess(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
  ): Promise<BusinessDocument> {
    if (!Types.ObjectId.isValid(businessId)) {
      throw new ClientError("CLIENT_BUSINESS_NOT_FOUND", 404);
    }

    const business = await this.businessRepository.findById(businessId);

    if (!business) {
      throw new ClientError("CLIENT_BUSINESS_NOT_FOUND", 404);
    }

    if (actorRole === "BUSINESS_OWNER") {
      if (!business.ownerUserId.equals(actorUserId)) {
        throw new ClientError("CLIENT_BUSINESS_NOT_FOUND", 404);
      }
      return business;
    }

    if (actorRole === "SUPERVISOR") {
      const membership = await this.staffRepository.findActiveByUserId(actorUserId);

      if (membership?.role !== "SUPERVISOR" || !membership.businessId.equals(business._id)) {
        throw new ClientError("CLIENT_BUSINESS_NOT_FOUND", 404);
      }
      return business;
    }

    throw new ClientError("CLIENT_BUSINESS_NOT_FOUND", 404);
  }

  private async requireClient(
    business: BusinessDocument,
    clientId: string,
    options: { excludeArchived?: boolean } = {},
  ): Promise<BusinessClientDocument> {
    if (!Types.ObjectId.isValid(clientId)) {
      throw new ClientError("CLIENT_NOT_FOUND", 404);
    }

    const client = await this.clientRepository.findById(business._id, clientId);

    if (!client || (options.excludeArchived && client.archivedAt)) {
      throw new ClientError("CLIENT_NOT_FOUND", 404);
    }

    return client;
  }

  private parsePhone(
    countryCode: string,
    nationalNumber: string,
  ): { countryCode: string; nationalNumber: string; e164: string } {
    try {
      return normalizePhoneNumber(countryCode, nationalNumber);
    } catch {
      throw new ClientError("CLIENT_PHONE_INVALID", 400);
    }
  }

  private mapDuplicateKeyError(error: unknown): ClientError {
    const keyPattern = (error as { keyPattern?: Record<string, unknown> } | null)?.keyPattern ?? {};

    if ("phone.e164" in keyPattern) {
      return new ClientError("CLIENT_DUPLICATE_PHONE", 409);
    }

    return new ClientError("CLIENT_DUPLICATE_EMAIL", 409);
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000
    );
  }

  // --- DTO mapping ------------------------------------------------------------------------

  /** Batches the linked-Customer identity lookup — one $in query regardless of list size. */
  private async toClientDtos(clients: BusinessClientDocument[]): Promise<BusinessClientDto[]> {
    const linkedUserIds = [
      ...new Set(
        clients
          .filter((client) => client.linkState === "LINKED" && client.linkedUserId)
          .map((client) => String(client.linkedUserId)),
      ),
    ];

    const [users, profiles] =
      linkedUserIds.length > 0
        ? await Promise.all([
            this.userRepository.findManyByIds(linkedUserIds),
            this.userRepository.findProfilesByUserIds(linkedUserIds),
          ])
        : [[], []];

    const userById = new Map(users.map((user) => [String(user._id), user]));
    const profileById = new Map(profiles.map((profile) => [String(profile.userId), profile]));

    return clients.map((client) => this.toClientDto(client, userById, profileById));
  }

  private toClientDto(
    client: BusinessClientDocument,
    userById: Map<string, { normalizedEmail: string }>,
    profileById: Map<
      string,
      {
        firstName: string;
        lastName: string;
        gender: "male" | "female" | "other";
        phone?: BusinessClientDocument["phone"] | undefined;
      }
    >,
  ): BusinessClientDto {
    const isLinked = client.linkState === "LINKED" && client.linkedUserId !== undefined;
    const linkedUser = isLinked ? userById.get(String(client.linkedUserId)) : undefined;
    const linkedProfile = isLinked ? profileById.get(String(client.linkedUserId)) : undefined;

    return {
      id: String(client._id),
      businessId: String(client.businessId),
      firstName: linkedProfile?.firstName ?? client.firstName,
      lastName: linkedProfile?.lastName ?? client.lastName,
      email: linkedUser?.normalizedEmail ?? client.normalizedEmail,
      phone: linkedProfile?.phone ?? client.phone,
      dateOfBirth: client.dateOfBirth,
      gender: linkedProfile?.gender ?? client.gender,
      address: client.address,
      notes: client.notes,
      tag: client.tag,
      linkState: client.linkState,
      isIdentityEditable: client.linkState !== "LINKED",
      createdAt: client.createdAt.toISOString(),
      updatedAt: client.updatedAt.toISOString(),
      archivedAt: client.archivedAt?.toISOString(),
    };
  }
}
