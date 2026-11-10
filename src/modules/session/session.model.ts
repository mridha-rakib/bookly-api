import { model, Schema, type Types } from "mongoose";

export type SessionDocument = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  refreshTokenHash: string;
  tokenFamilyId: string;
  authenticatedAt?: Date;
  twoFactorVersion?: number;
  expiresAt: Date;
  revokedAt?: Date | undefined;
  revocationVersion?: number;
  revocationReason?: "ADMIN_SUSPENSION" | "LOGOUT" | "REVOKE_ALL" | "TOKEN_REUSE" | "ROTATED";
  replacedBySessionId?: Types.ObjectId | undefined;
  createdAt: Date;
  lastUsedAt?: Date | undefined;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
};

const sessionSchema = new Schema<SessionDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    refreshTokenHash: { type: String, required: true, unique: true, select: false },
    tokenFamilyId: { type: String, required: true },
    authenticatedAt: { type: Date },
    twoFactorVersion: { type: Number },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    revocationReason: {
      type: String,
      enum: ["ADMIN_SUSPENSION", "LOGOUT", "REVOKE_ALL", "TOKEN_REUSE", "ROTATED"],
    },
    // Ensures repeated family revocations write even within the same millisecond.
    revocationVersion: { type: Number, default: 0 },
    replacedBySessionId: { type: Schema.Types.ObjectId, ref: "Session" },
    lastUsedAt: { type: Date },
    userAgent: { type: String },
    ipAddress: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Supports user-scoped revocation and active-session selection.
sessionSchema.index({ userId: 1, revokedAt: 1 });
// Family revocation uses the tokenFamilyId prefix, including consumed ancestors, so it
// conflicts with concurrent rotation. The existing compound index supports that prefix.
sessionSchema.index({ tokenFamilyId: 1, revokedAt: 1 });

export const SessionModel = model<SessionDocument>("Session", sessionSchema);
