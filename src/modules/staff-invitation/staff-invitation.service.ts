import { Types } from "mongoose";

import { createOpaqueToken, normalizeEmail, sha256 } from "../auth/auth.utils.js";
import type { StaffCreatableRole } from "../staff/staff.types.js";
import type { UserRepository } from "../user/user.repository.js";
import { StaffInvitationError } from "./staff-invitation.errors.js";
import type { StaffInvitationDocument } from "./staff-invitation.model.js";
import type { StaffInvitationRepository } from "./staff-invitation.repository.js";
import { STAFF_INVITATION_TTL_HOURS } from "./staff-invitation.types.js";

const MS_PER_HOUR = 60 * 60 * 1000;

export type IssueStaffInvitationInput = {
  businessId: Types.ObjectId | string;
  invitedByUserId: Types.ObjectId | string;
  email: string;
  role: StaffCreatableRole;
  /** Overrides {@link STAFF_INVITATION_TTL_HOURS} for this one invitation. */
  ttlHours?: number | undefined;
};

export type IssuedStaffInvitation = {
  invitation: StaffInvitationDocument;
  /** Raw token for the invite-email link — never persisted; callers must not log it. */
  token: string;
};

/**
 * Phase 2A foundation — issue / inspect / revoke staff invitations.
 *
 * Deliberately NOT called by StaffService yet; the existing temp-password staff-creation path is
 * untouched. A later phase wires {@link issue} into the owner's "add staff" action and adds an
 * accept flow that consumes the token via {@link redeemToken} + StaffInvitationRepository.
 * markAccepted (in the same transaction that provisions the User + StaffMembership).
 *
 * Holds no HTTP concerns and no direct Mongo access. Reuses the auth module's helpers
 * (createOpaqueToken / sha256 / normalizeEmail) exactly as LinkedAccountService and StaffService
 * already do.
 */
export class StaffInvitationService {
  public constructor(
    private readonly staffInvitationRepository: StaffInvitationRepository,
    private readonly userRepository: UserRepository,
  ) {}

  /**
   * Creates a PENDING invitation and returns it together with the raw token for the email link.
   * Rejects if the email already belongs to a User (STAFF_INVITATION_EMAIL_IN_USE) or an open
   * invitation for this (business, email) already exists (STAFF_INVITATION_ALREADY_PENDING) — the
   * partial-unique index is the race-safe backstop for the latter.
   */
  public async issue(input: IssueStaffInvitationInput): Promise<IssuedStaffInvitation> {
    const email = normalizeEmail(input.email);
    const businessId = new Types.ObjectId(String(input.businessId));

    if (await this.userRepository.findByEmail(email)) {
      throw new StaffInvitationError("STAFF_INVITATION_EMAIL_IN_USE", 409);
    }

    if (await this.staffInvitationRepository.findPendingByBusinessAndEmail(businessId, email)) {
      throw new StaffInvitationError("STAFF_INVITATION_ALREADY_PENDING", 409);
    }

    const token = createOpaqueToken();
    const now = new Date();
    const ttlHours = input.ttlHours ?? STAFF_INVITATION_TTL_HOURS;

    try {
      const invitation = await this.staffInvitationRepository.create({
        businessId,
        email,
        role: input.role,
        invitedByUserId: new Types.ObjectId(String(input.invitedByUserId)),
        tokenHash: sha256(token),
        expiresAt: new Date(now.getTime() + ttlHours * MS_PER_HOUR),
        resendTimestamps: [now],
      });

      return { invitation, token };
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        // Lost a race against a concurrent issue for the same (business, email).
        throw new StaffInvitationError("STAFF_INVITATION_ALREADY_PENDING", 409);
      }
      throw error;
    }
  }

  /**
   * Resolves a raw invite token to its PENDING, unexpired invitation, or throws. A past-due
   * PENDING row is flipped to EXPIRED (best-effort) before the error, so the owner's list
   * reflects reality without waiting on a separate sweep.
   */
  public async redeemToken(token: string): Promise<StaffInvitationDocument> {
    const invitation = await this.staffInvitationRepository.findByTokenHash(sha256(token));

    if (!invitation) {
      throw new StaffInvitationError("STAFF_INVITATION_TOKEN_INVALID", 404);
    }

    if (invitation.status !== "PENDING") {
      throw new StaffInvitationError("STAFF_INVITATION_NOT_PENDING", 409);
    }

    if (invitation.expiresAt.getTime() <= Date.now()) {
      await this.staffInvitationRepository.markExpired(invitation._id);
      throw new StaffInvitationError("STAFF_INVITATION_EXPIRED", 410);
    }

    return invitation;
  }

  /** Owner cancels a still-pending invitation. Scoped to the owner's business. */
  public async revoke(input: {
    invitationId: Types.ObjectId | string;
    businessId: Types.ObjectId | string;
  }): Promise<StaffInvitationDocument> {
    const invitation = await this.staffInvitationRepository.findById(input.invitationId);

    if (!invitation || String(invitation.businessId) !== String(input.businessId)) {
      throw new StaffInvitationError("STAFF_INVITATION_NOT_FOUND", 404);
    }

    const revoked = await this.staffInvitationRepository.markRevoked(invitation._id, new Date());

    if (!revoked) {
      throw new StaffInvitationError("STAFF_INVITATION_NOT_PENDING", 409);
    }

    return revoked;
  }

  public async listForBusiness(
    businessId: Types.ObjectId | string,
  ): Promise<StaffInvitationDocument[]> {
    return this.staffInvitationRepository.listByBusinessId(businessId);
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}
