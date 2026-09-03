import { type HydratedDocument, model, Schema, type Types } from "mongoose";

import type { BusinessVisitType } from "../business/business.types.js";
import type { Gender, PhoneNumber } from "../user/user.types.js";

export const registrationPortals = ["CUSTOMER", "PROFESSIONAL"] as const;
export type RegistrationPortal = (typeof registrationPortals)[number];

/**
 * How the registration is being completed. Phase 2C — a `"GOOGLE"` PROFESSIONAL session carries a
 * Google-verified identity + email and never collects a password; `"PASSWORD"` is the classic
 * email + password + OTP flow. Absent on rows written before Phase 2C — resolve via
 * {@link resolveRegistrationAuthProvider}.
 */
export const registrationAuthProviders = ["PASSWORD", "GOOGLE"] as const;
export type RegistrationAuthProvider = (typeof registrationAuthProviders)[number];

export const resolveRegistrationAuthProvider = (
  value: RegistrationAuthProvider | undefined,
): RegistrationAuthProvider => value ?? "PASSWORD";

export const registrationSteps = [
  "EMAIL_ENTRY",
  "VISIT_TYPE_SELECTED",
  "EMAIL_OTP_SENT",
  "EMAIL_VERIFIED",
  "PROFILE_SUBMITTED",
  "PHONE_OTP_SENT",
  "PHONE_VERIFIED",
  "BUSINESS_DETAILS_SUBMITTED",
  "CATEGORIES_SUBMITTED",
  "COMPLETED",
] as const;
export type RegistrationStep = (typeof registrationSteps)[number];

export type RegistrationSession = {
  _id: Types.ObjectId;
  portal: RegistrationPortal;
  intendedRole: "CUSTOMER" | "BUSINESS_OWNER";
  normalizedEmail: string;
  isActive: boolean;
  currentStep: RegistrationStep;
  emailVerification: {
    verifiedAt?: Date | undefined;
    otpHash?: string | undefined;
    otpExpiresAt?: Date | undefined;
    attempts: number;
    resendTimestamps: Date[];
    sentAt?: Date | undefined;
  };
  personalProfile?: {
    firstName: string;
    lastName: string;
    gender: Gender;
  };
  phone?: PhoneNumber | undefined;
  phoneVerification: {
    verifiedAt?: Date | undefined;
    attempts: number;
    resendTimestamps: Date[];
    sentAt?: Date | undefined;
    providerVerificationId?: string | undefined;
  };
  passwordHash?: string | undefined;
  /** Phase 2C — absent means "PASSWORD" (see resolveRegistrationAuthProvider). */
  authProvider?: RegistrationAuthProvider | undefined;
  /** GOOGLE sessions only — the Google OIDC `sub`, threaded through to completeBusinessOwner so
   * the LinkedAccount is created in the SAME transaction as the User + Business. Not a
   * credential (an opaque stable id), so not `select:false` — mirrors LinkedAccount.providerAccountId. */
  googleProviderAccountId?: string | undefined;
  termsAcceptedAt?: Date | undefined;
  termsVersion?: string | undefined;
  businessVisitType?: BusinessVisitType | undefined;
  businessOnboardingDraftId?: Types.ObjectId | undefined;
  completedUserId?: Types.ObjectId | undefined;
  completedBusinessId?: Types.ObjectId | undefined;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type RegistrationSessionDocument = HydratedDocument<RegistrationSession>;

const registrationSessionSchema = new Schema<RegistrationSession>(
  {
    portal: { type: String, enum: registrationPortals, required: true },
    intendedRole: { type: String, enum: ["CUSTOMER", "BUSINESS_OWNER"], required: true },
    normalizedEmail: { type: String, required: true, lowercase: true, trim: true },
    isActive: { type: Boolean, required: true, default: true },
    currentStep: { type: String, enum: registrationSteps, required: true },
    emailVerification: {
      verifiedAt: { type: Date },
      otpHash: { type: String, select: false },
      otpExpiresAt: { type: Date },
      attempts: { type: Number, required: true, default: 0 },
      resendTimestamps: { type: [Date], required: true, default: [] },
      sentAt: { type: Date },
    },
    personalProfile: {
      firstName: { type: String, trim: true },
      lastName: { type: String, trim: true },
      gender: { type: String, enum: ["male", "female", "other"] },
    },
    phone: {
      countryCode: { type: String },
      nationalNumber: { type: String },
      e164: { type: String },
    },
    phoneVerification: {
      verifiedAt: { type: Date },
      attempts: { type: Number, required: true, default: 0 },
      resendTimestamps: { type: [Date], required: true, default: [] },
      sentAt: { type: Date },
      providerVerificationId: { type: String, select: false },
    },
    passwordHash: { type: String, select: false },
    authProvider: { type: String, enum: registrationAuthProviders },
    googleProviderAccountId: { type: String, trim: true },
    termsAcceptedAt: { type: Date },
    termsVersion: { type: String },
    businessVisitType: {
      type: String,
      enum: ["AT_BUSINESS_LOCATION", "TRAVEL_TO_CUSTOMER", "location", "travel"],
    },
    businessOnboardingDraftId: { type: Schema.Types.ObjectId, ref: "BusinessOnboardingDraft" },
    completedUserId: { type: Schema.Types.ObjectId, ref: "User" },
    completedBusinessId: { type: Schema.Types.ObjectId, ref: "Business" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

registrationSessionSchema.index({ normalizedEmail: 1, portal: 1 });
registrationSessionSchema.index(
  { normalizedEmail: 1, portal: 1, isActive: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);
registrationSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RegistrationSessionModel = model<RegistrationSession>(
  "RegistrationSession",
  registrationSessionSchema,
);
