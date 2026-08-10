import { type HydratedDocument, model, Schema, type Types } from "mongoose";

export type BusinessLinkVerification = {
  _id: Types.ObjectId;
  requesterUserId: Types.ObjectId;
  targetUserId: Types.ObjectId;
  targetBusinessId: Types.ObjectId;
  normalizedEmail: string;
  otpHash?: string | undefined;
  otpExpiresAt: Date;
  attempts: number;
  resendTimestamps: Date[];
  sentAt?: Date | undefined;
  consumedAt?: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
};

export type BusinessLinkVerificationDocument = HydratedDocument<BusinessLinkVerification>;

const businessLinkVerificationSchema = new Schema<BusinessLinkVerification>(
  {
    requesterUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    targetUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    targetBusinessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    normalizedEmail: { type: String, required: true, lowercase: true, trim: true },
    otpHash: { type: String, select: false },
    otpExpiresAt: { type: Date, required: true },
    attempts: { type: Number, required: true, default: 0 },
    resendTimestamps: { type: [Date], required: true, default: [] },
    sentAt: { type: Date },
    consumedAt: { type: Date },
  },
  { timestamps: true },
);

// The record's entire lifecycle is the OTP lifecycle, so this alone provisions cleanup.
// TTL sweeps are asynchronous — service logic independently validates otpExpiresAt and
// never relies on the document having already been removed.
businessLinkVerificationSchema.index({ otpExpiresAt: 1 }, { expireAfterSeconds: 0 });

export const BusinessLinkVerificationModel = model<BusinessLinkVerification>(
  "BusinessLinkVerification",
  businessLinkVerificationSchema,
);
