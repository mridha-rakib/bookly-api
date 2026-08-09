import { model, Schema, type Types } from "mongoose";

export type SessionDocument = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  refreshTokenHash: string;
  tokenFamilyId: string;
  expiresAt: Date;
  revokedAt?: Date | undefined;
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
    replacedBySessionId: { type: Schema.Types.ObjectId, ref: "Session" },
    lastUsedAt: { type: Date },
    userAgent: { type: String },
    ipAddress: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ userId: 1, revokedAt: 1 });

export const SessionModel = model<SessionDocument>("Session", sessionSchema);
