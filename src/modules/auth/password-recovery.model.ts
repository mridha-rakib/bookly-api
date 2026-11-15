import { model, Schema, type Types } from "mongoose";

export type PasswordRecoveryChallenge = {
  _id: string;
  portal: "CUSTOMER" | "PROFESSIONAL";
  userId?: Types.ObjectId;
  challengeHash: string;
  otpHash: string;
  expiresAt: Date;
  attempts: number;
  sends: Date[];
  resetHash?: string;
  resetExpiresAt?: Date;
  passwordStamp?: Date;
};
const schema = new Schema<PasswordRecoveryChallenge>(
  {
    _id: { type: String, required: true },
    portal: { type: String, required: true },
    userId: Schema.Types.ObjectId,
    challengeHash: { type: String, required: true },
    otpHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    sends: { type: [Date], default: [] },
    resetHash: String,
    resetExpiresAt: Date,
    passwordStamp: Date,
  },
  { versionKey: false, autoIndex: false },
);
schema.index({ challengeHash: 1 }, { unique: true });
schema.index(
  { resetHash: 1 },
  { unique: true, partialFilterExpression: { resetHash: { $type: "string" } } },
);
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });
export const PasswordRecoveryModel = model<PasswordRecoveryChallenge>(
  "PasswordRecoveryChallenge",
  schema,
);
