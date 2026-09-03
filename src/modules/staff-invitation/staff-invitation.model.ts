import { model, Schema, type Types } from "mongoose";

import { type StaffCreatableRole, staffCreatableRoles } from "../staff/staff.types.js";
import {
  type StaffInvitationAuthProvider,
  type StaffInvitationStatus,
  staffInvitationAuthProviders,
  staffInvitationStatuses,
} from "./staff-invitation.types.js";

/**
 * An owner-issued invitation for a SUPERVISOR/STAFF to join a Business (Phase 2D).
 *
 * Accepting an invitation — set a password, or link a Google identity — is what creates the
 * User + UserProfile + StaffMembership, in ONE transaction, and flips `status` to ACCEPTED.
 * A User NEVER exists before acceptance. Google is not an account-creation path in its own
 * right: the invitation is; Google is only how the invitee proves an identity + activates.
 *
 * The raw token is emailed to the invitee and never stored — only its sha256 hex (`tokenHash`,
 * `select:false`) is persisted, mirroring Session.refreshTokenHash and
 * ContactChangeChallenge.otpHash.
 */
export type StaffInvitationDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  email: string;
  role: StaffCreatableRole;
  invitedByUserId: Types.ObjectId;
  tokenHash: string;
  status: StaffInvitationStatus;
  expiresAt: Date;
  /** Optional name the owner typed on the "Add staff" form — prefilled on the accept screen. */
  firstName?: string | undefined;
  lastName?: string | undefined;
  /** Set at acceptance — which mechanism the invitee used. Absent while PENDING. */
  authProvider?: StaffInvitationAuthProvider | undefined;
  /** Set only on a GOOGLE acceptance — the Google OIDC `sub` that was consumed (audit). */
  googleProviderAccountId?: string | undefined;
  acceptedUserId?: Types.ObjectId | undefined;
  acceptedAt?: Date | undefined;
  revokedAt?: Date | undefined;
  resendTimestamps: Date[];
  createdAt: Date;
  updatedAt: Date;
};

const staffInvitationSchema = new Schema<StaffInvitationDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: staffCreatableRoles, required: true },
    invitedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    tokenHash: { type: String, required: true, select: false },
    status: {
      type: String,
      enum: staffInvitationStatuses,
      required: true,
      default: "PENDING",
    },
    expiresAt: { type: Date, required: true },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    authProvider: { type: String, enum: staffInvitationAuthProviders },
    googleProviderAccountId: { type: String, trim: true },
    acceptedUserId: { type: Schema.Types.ObjectId, ref: "User" },
    acceptedAt: { type: Date },
    revokedAt: { type: Date },
    resendTimestamps: { type: [Date], required: true, default: [] },
  },
  { timestamps: true },
);

// Token redemption path — the raw token is sha256'd and looked up here. Unique: every issue
// mints a fresh 48-byte token, so a hash collision would be a genuine fault, not a reuse.
staffInvitationSchema.index({ tokenHash: 1 }, { unique: true });
// At most one OPEN invitation per (business, email). Partial on status:"PENDING" so a
// revoked / expired / accepted row never blocks re-inviting the same person — same active-only
// partial-unique pattern as StaffMembership's `userId` index.
staffInvitationSchema.index(
  { businessId: 1, email: 1 },
  { unique: true, partialFilterExpression: { status: "PENDING" } },
);
// Owner's "invitations for this business" list, and the expiry sweep
// ({ status: "PENDING", expiresAt: { $lte: now } }).
staffInvitationSchema.index({ businessId: 1, status: 1, expiresAt: 1 });

export const StaffInvitationModel = model<StaffInvitationDocument>(
  "StaffInvitation",
  staffInvitationSchema,
);
