import type { ClientSession, Types } from "mongoose";

import { type StaffInvitationDocument, StaffInvitationModel } from "./staff-invitation.model.js";
import type {
  StaffInvitationAuthProvider,
  StaffInvitationStatus,
} from "./staff-invitation.types.js";

export type CreateStaffInvitationInput = {
  businessId: Types.ObjectId;
  email: string;
  role: StaffInvitationDocument["role"];
  invitedByUserId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  resendTimestamps: Date[];
  firstName?: string | undefined;
  lastName?: string | undefined;
};

/**
 * Data access only — no domain rules. Email-in-use checks, token generation/hashing, expiry
 * decisions and the resend policy all live in StaffInvitationService. Mirrors the thin
 * LinkedAccountRepository / ContactChangeChallengeRepository style.
 */
export class StaffInvitationRepository {
  public async create(
    input: CreateStaffInvitationInput,
    session?: ClientSession,
  ): Promise<StaffInvitationDocument> {
    return new StaffInvitationModel(input).save(session ? { session } : undefined);
  }

  public async findById(id: Types.ObjectId | string): Promise<StaffInvitationDocument | null> {
    return StaffInvitationModel.findById(id).exec();
  }

  /** Includes the normally-hidden `tokenHash` — only the redemption path calls this. */
  public async findByTokenHash(tokenHash: string): Promise<StaffInvitationDocument | null> {
    return StaffInvitationModel.findOne({ tokenHash }).select("+tokenHash").exec();
  }

  public async findPendingByBusinessAndEmail(
    businessId: Types.ObjectId | string,
    email: string,
  ): Promise<StaffInvitationDocument | null> {
    return StaffInvitationModel.findOne({ businessId, email, status: "PENDING" }).exec();
  }

  public async listByBusinessId(
    businessId: Types.ObjectId | string,
    filter: { status?: StaffInvitationStatus | undefined } = {},
  ): Promise<StaffInvitationDocument[]> {
    const query: Record<string, unknown> = { businessId };
    if (filter.status) {
      query["status"] = filter.status;
    }
    return StaffInvitationModel.find(query).sort({ createdAt: -1 }).exec();
  }

  /**
   * Atomic accept — CAS-guarded on `status: "PENDING"`, so a concurrent revoke / expire / second
   * accept matches zero documents and the caller treats it as "no longer pending". Meant to run
   * inside the same transaction that creates the User + StaffMembership (hence `session`).
   */
  public async markAccepted(
    id: Types.ObjectId,
    acceptedUserId: Types.ObjectId,
    acceptedAt: Date,
    session?: ClientSession,
  ): Promise<StaffInvitationDocument | null> {
    return StaffInvitationModel.findOneAndUpdate(
      { _id: id, status: "PENDING" },
      { $set: { status: "ACCEPTED", acceptedUserId, acceptedAt } },
      { returnDocument: "after", ...(session ? { session } : {}) },
    ).exec();
  }

  /**
   * Owner "resend": rotate to a fresh token hash + expiry, CAS-guarded on `status: "PENDING"`.
   * Returns the updated doc, or `null` if the invitation was no longer pending.
   */
  public async refreshToken(
    id: Types.ObjectId,
    input: { tokenHash: string; expiresAt: Date; resendTimestamps: Date[] },
  ): Promise<StaffInvitationDocument | null> {
    return StaffInvitationModel.findOneAndUpdate(
      { _id: id, status: "PENDING" },
      { $set: input },
      { returnDocument: "after" },
    )
      .select("+tokenHash")
      .exec();
  }

  /**
   * Records HOW the invitation was accepted (audit only) inside the acceptance transaction —
   * called right after {@link markAccepted}, so it does not re-guard on status.
   */
  public async setAcceptanceMeta(
    id: Types.ObjectId,
    meta: { authProvider: StaffInvitationAuthProvider; googleProviderAccountId?: string },
    session?: ClientSession,
  ): Promise<void> {
    await StaffInvitationModel.updateOne(
      { _id: id },
      {
        $set: {
          authProvider: meta.authProvider,
          ...(meta.googleProviderAccountId
            ? { googleProviderAccountId: meta.googleProviderAccountId }
            : {}),
        },
      },
      session ? { session } : undefined,
    ).exec();
  }

  /** CAS-guarded on `status: "PENDING"` — a non-pending invitation is left untouched. */
  public async markRevoked(
    id: Types.ObjectId,
    revokedAt: Date,
  ): Promise<StaffInvitationDocument | null> {
    return StaffInvitationModel.findOneAndUpdate(
      { _id: id, status: "PENDING" },
      { $set: { status: "REVOKED", revokedAt } },
      { returnDocument: "after" },
    ).exec();
  }

  /** CAS-guarded on `status: "PENDING"`. Idempotent — a second call matches nothing. */
  public async markExpired(id: Types.ObjectId): Promise<void> {
    await StaffInvitationModel.updateOne(
      { _id: id, status: "PENDING" },
      { $set: { status: "EXPIRED" } },
    ).exec();
  }

  public async replaceResendTimestamps(id: Types.ObjectId, timestamps: Date[]): Promise<void> {
    await StaffInvitationModel.updateOne(
      { _id: id },
      { $set: { resendTimestamps: timestamps } },
    ).exec();
  }
}
