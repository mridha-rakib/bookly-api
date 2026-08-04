import { model, Schema, type Types } from "mongoose";

import { genders, type UserRole, type UserStatus, userRoles, userStatuses } from "./user.types.js";

export type UserDocument = {
  _id: Types.ObjectId;
  normalizedEmail: string;
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  emailVerifiedAt?: Date | undefined;
  phoneVerifiedAt?: Date | undefined;
  security: {
    passwordUpdatedAt: Date;
    lastLoginAt?: Date | undefined;
  };
  createdAt: Date;
  updatedAt: Date;
};

const userSchema = new Schema<UserDocument>(
  {
    normalizedEmail: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: userRoles, required: true },
    status: { type: String, enum: userStatuses, required: true, default: "ACTIVE" },
    emailVerifiedAt: { type: Date },
    phoneVerifiedAt: { type: Date },
    security: {
      passwordUpdatedAt: { type: Date, required: true },
      lastLoginAt: { type: Date },
    },
  },
  { timestamps: true },
);

userSchema.index({ normalizedEmail: 1 }, { unique: true });
userSchema.index({ role: 1, status: 1 });

export const UserModel = model<UserDocument>("User", userSchema);

export type UserProfileDocument = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  firstName: string;
  lastName: string;
  gender: "male" | "female" | "other";
  phone: {
    countryCode: string;
    nationalNumber: string;
    e164: string;
  };
  termsAcceptedAt?: Date | undefined;
  termsVersion?: string | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const userProfileSchema = new Schema<UserProfileDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    gender: { type: String, enum: genders, required: true },
    phone: {
      countryCode: { type: String, required: true },
      nationalNumber: { type: String, required: true },
      e164: { type: String, required: true },
    },
    termsAcceptedAt: { type: Date },
    termsVersion: { type: String },
  },
  { timestamps: true },
);

userProfileSchema.index({ userId: 1 }, { unique: true });
userProfileSchema.index({ "phone.e164": 1 });

export const UserProfileModel = model<UserProfileDocument>("UserProfile", userProfileSchema);

export type CustomerProfileDocument = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  address?: string | undefined;
  dateOfBirth?: string | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const customerProfileSchema = new Schema<CustomerProfileDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    address: { type: String, trim: true },
    dateOfBirth: { type: String },
  },
  { timestamps: true },
);

customerProfileSchema.index({ userId: 1 }, { unique: true });

export const CustomerProfileModel = model<CustomerProfileDocument>(
  "CustomerProfile",
  customerProfileSchema,
);
