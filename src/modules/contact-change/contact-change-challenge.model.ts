import { type HydratedDocument, model, Schema, type Types } from "mongoose";

import type { PhoneNumber } from "../user/user.types.js";

/**
 * Batch 18 — authenticated Customer email/phone self-service change. Deliberately NOT built on
 * RegistrationSessionModel: that model is a registration-flow state machine (portal/intendedRole/
 * currentStep/businessOnboardingDraftId/...), none of which applies to an already-authenticated
 * user changing one piece of contact info. This is the smallest purpose-specific shape, keyed by
 * (userId, purpose) so there is always exactly one active challenge slot per user per purpose —
 * a new change-request simply overwrites it (see repository upsert methods).
 */
export const contactChangePurposes = ["EMAIL_CHANGE", "PHONE_CHANGE"] as const;
export type ContactChangePurpose = (typeof contactChangePurposes)[number];

export type ContactChangeChallenge = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  purpose: ContactChangePurpose;
  /** EMAIL_CHANGE only. */
  newNormalizedEmail?: string | undefined;
  /** EMAIL_CHANGE only — Bookly generates/hashes/verifies email OTPs itself (see auth.utils.ts). */
  otpHash?: string | undefined;
  otpExpiresAt?: Date | undefined;
  /** PHONE_CHANGE only. */
  newPhone?: PhoneNumber | undefined;
  /** PHONE_CHANGE only — Twilio Verify owns OTP generation/expiry/attempts on its side; this is
   * only Bookly's handle for the `verificationChecks.create` call. */
  providerVerificationId?: string | undefined;
  attempts: number;
  resendTimestamps: Date[];
  sentAt?: Date | undefined;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type ContactChangeChallengeDocument = HydratedDocument<ContactChangeChallenge>;

const contactChangeChallengeSchema = new Schema<ContactChangeChallenge>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    purpose: { type: String, enum: contactChangePurposes, required: true },
    newNormalizedEmail: { type: String, lowercase: true, trim: true },
    otpHash: { type: String, select: false },
    otpExpiresAt: { type: Date },
    newPhone: {
      countryCode: { type: String },
      nationalNumber: { type: String },
      e164: { type: String },
    },
    providerVerificationId: { type: String, select: false },
    attempts: { type: Number, required: true, default: 0 },
    resendTimestamps: { type: [Date], required: true, default: [] },
    sentAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// One active challenge slot per user per purpose — a new change-request upserts (overwrites)
// this same row rather than accumulating rows, which is what keeps "multiple uncontrolled active
// challenges" (Batch 18 §8) structurally impossible rather than just policy.
contactChangeChallengeSchema.index({ userId: 1, purpose: 1 }, { unique: true });
// Mirrors RegistrationSessionModel's TTL convention — bounded storage, no cron/cleanup job needed.
contactChangeChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ContactChangeChallengeModel = model<ContactChangeChallenge>(
  "ContactChangeChallenge",
  contactChangeChallengeSchema,
);
