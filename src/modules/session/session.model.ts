import { model, Schema, type Types } from "mongoose";

export type SessionDocument = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  refreshTokenHash: string;
  tokenFamilyId: string;
  expiresAt: Date;
  revokedAt?: Date | undefined;
  revocationVersion?: number;
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
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
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
// NOTE (audit finding, documented rather than dropped per this batch's index-change policy):
// no query in session.repository.ts filters on {userId, revokedAt} together — this index
// currently has zero known callers. Left in place; a future maintenance pass should confirm
// and drop it rather than removing it opportunistically here.
sessionSchema.index({ userId: 1, revokedAt: 1 });
// Family revocation uses the tokenFamilyId prefix, including consumed ancestors, so it
// conflicts with concurrent rotation. The existing compound index supports that prefix.
sessionSchema.index({ tokenFamilyId: 1, revokedAt: 1 });

export const SessionModel = model<SessionDocument>("Session", sessionSchema);
