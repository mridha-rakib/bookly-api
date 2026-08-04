import { model, Schema, type Types } from "mongoose";

import type { BusinessVisitType } from "../business/business.types.js";
import type { Gender, PhoneNumber } from "../user/user.types.js";

export const registrationPortals = ["CUSTOMER", "PROFESSIONAL"] as const;
export type RegistrationPortal = (typeof registrationPortals)[number];

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

export type RegistrationSessionDocument = {
  _id: Types.ObjectId;
  portal: RegistrationPortal;
  intendedRole: "CUSTOMER" | "BUSINESS_OWNER";
  normalizedEmail: string;
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

const registrationSessionSchema = new Schema<RegistrationSessionDocument>(
  {
    portal: { type: String, enum: registrationPortals, required: true },
    intendedRole: { type: String, enum: ["CUSTOMER", "BUSINESS_OWNER"], required: true },
    normalizedEmail: { type: String, required: true, lowercase: true, trim: true },
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
    termsAcceptedAt: { type: Date },
    termsVersion: { type: String },
    businessVisitType: { type: String, enum: ["location", "travel"] },
    businessOnboardingDraftId: { type: Schema.Types.ObjectId, ref: "BusinessOnboardingDraft" },
    completedUserId: { type: Schema.Types.ObjectId, ref: "User" },
    completedBusinessId: { type: Schema.Types.ObjectId, ref: "Business" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

registrationSessionSchema.index({ normalizedEmail: 1, portal: 1 });
registrationSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RegistrationSessionModel = model<RegistrationSessionDocument>(
  "RegistrationSession",
  registrationSessionSchema,
);
