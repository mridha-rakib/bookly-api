import { model, Schema, type Types } from "mongoose";

export type TwoFactorChallenge = {
  _id: Types.ObjectId;
  tokenHash: string;
  userId: Types.ObjectId;
  version: number;
  identityStamp: string;
  expiresAt: Date;
  attempts: number;
  usedAt?: Date;
};

// Pre-authentication only: these records never authorize an API operation or refresh.
const schema = new Schema<TwoFactorChallenge>({
  tokenHash: { type: String, required: true, unique: true, select: false },
  userId: { type: Schema.Types.ObjectId, required: true },
  version: { type: Number, required: true },
  identityStamp: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  attempts: { type: Number, required: true, default: 0 },
  usedAt: Date,
});
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const TwoFactorChallengeModel = model<TwoFactorChallenge>("TwoFactorChallenge", schema);
