import { model, Schema, type Types } from "mongoose";

import {
  type AuthProvider,
  authProviders,
  genders,
  type MarketingEmailConsent,
  marketingEmailConsentSources,
  type NotificationPreferences,
  type UserLanguage,
  type UserRole,
  type UserStatus,
  userLanguages,
  userRoles,
  userStatuses,
} from "./user.types.js";

export type UserDocument = {
  _id: Types.ObjectId;
  normalizedEmail: string;
  /**
   * Argon2 hash for email/password login. Optional as of Phase 2A: a Google-only account has
   * none. Every account that existed before Phase 2A has one, so no data migration is needed —
   * {@link assertUserAuthProvidersConsistent} keeps this in lockstep with `authProviders`. Still
   * `select:false`; never returned unless explicitly `.select("+passwordHash")`.
   */
  passwordHash?: string | undefined;
  /**
   * Which mechanisms this User can authenticate with (see {@link AuthProvider}). Always contains
   * at least one entry. Legacy rows written before this field read back absent on `.lean()`
   * paths — go through {@link resolveAuthProviders}.
   */
  authProviders: AuthProvider[];
  role: UserRole;
  status: UserStatus;
  emailVerifiedAt?: Date | undefined;
  phoneVerifiedAt?: Date | undefined;
  security: {
    passwordUpdatedAt: Date;
    lastLoginAt?: Date | undefined;
  };
  /**
   * Account-closure audit metadata (soft delete). Written once, together with
   * `status: "DELETED"`, by AuthService.deleteMyAccount. `deletedBy` records who performed the
   * closure — for customer self-service that is the customer themselves (`actorRole: "CUSTOMER"`).
   * `deletionReason` is optional free-text (schema supports it; the v1 UI never sends one).
   */
  deletedAt?: Date | undefined;
  deletedBy?: { actorUserId: Types.ObjectId; actorRole: UserRole } | undefined;
  deletionReason?: string | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const userSchema = new Schema<UserDocument>(
  {
    normalizedEmail: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: false, select: false },
    // Non-empty by construction (repository default + assertUserAuthProvidersConsistent). The
    // schema `default` self-heals a hydrated read of a legacy row; `.lean()` callers use
    // resolveAuthProviders. No index — nothing queries by it yet.
    authProviders: {
      type: [String],
      enum: authProviders,
      required: true,
      default: ["PASSWORD"],
    },
    role: { type: String, enum: userRoles, required: true },
    status: { type: String, enum: userStatuses, required: true, default: "ACTIVE" },
    emailVerifiedAt: { type: Date },
    phoneVerifiedAt: { type: Date },
    security: {
      passwordUpdatedAt: { type: Date, required: true },
      lastLoginAt: { type: Date },
    },
    // Soft-delete audit metadata — optional sub-doc, `_id: false`, `default: undefined` (mirrors
    // the `marketingEmailConsent` sub-doc convention below). Set once by
    // AuthService.deleteMyAccount alongside `status: "DELETED"`.
    deletedAt: { type: Date },
    deletedBy: {
      type: {
        actorUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
        actorRole: { type: String, enum: userRoles, required: true },
      },
      required: false,
      _id: false,
      default: undefined,
    },
    deletionReason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

userSchema.index({ role: 1, status: 1 });
// Batch 12 — Super Admin Customer Analytics "customers registered over time": filters by role
// then buckets/sorts by createdAt; the index above doesn't have createdAt trailing.
userSchema.index({ role: 1, createdAt: -1 });

export const UserModel = model<UserDocument>("User", userSchema);

export type UserProfileDocument = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  firstName: string;
  lastName: string;
  gender: "male" | "female" | "other";
  phone?:
    | {
        countryCode: string;
        nationalNumber: string;
        e164: string;
      }
    | undefined;
  /** Account UI language preference. Optional: rows created before this field default to "EN"
   * at read time (see AuthService.getMe). */
  defaultLanguage?: UserLanguage | undefined;
  /** Customer-configurable OPTIONAL notification channels (24h appointment reminder + marketing-
   * email opt-in, Stage M1). Absent — or an absent sub-field — means "product default" (see
   * resolveNotificationPreferences / NOTIFICATION_PREFERENCE_DEFAULTS); no migration needed.
   * Never suppresses mandatory transactional or security mail. */
  notifications?: NotificationPreferences | undefined;
  /** Provenance of the current `notifications.marketingEmail` value (Stage M3A) — audit only,
   * eligibility never reads it. Absent on legacy rows (no backfill); written on the next
   * preference mutation. */
  marketingEmailConsent?: MarketingEmailConsent | undefined;
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
      countryCode: { type: String },
      nationalNumber: { type: String },
      e164: { type: String },
    },
    defaultLanguage: { type: String, enum: userLanguages },
    // Optional, no `_id`, `default: undefined` — mirrors the CustomerAvatar sub-doc pattern
    // below. A dot-path `$set` (see UserRepository.updateProfile) writes one channel without
    // touching the sibling; an absent field is resolved to the product default at read time.
    notifications: {
      type: {
        appointmentReminderEmail: { type: Boolean },
        appointmentReminderSms: { type: Boolean },
        // Marketing-email opt-in (Stage M1 — preference foundation only). Same style as the
        // reminder channels: plain optional Boolean, no default, no index. Absent resolves to
        // `false` (see resolveNotificationPreferences). Nothing sends marketing email yet.
        marketingEmail: { type: Boolean },
      },
      required: false,
      _id: false,
      default: undefined,
    },
    // Stage M3A — audit provenance for `notifications.marketingEmail`. Optional, no `_id`,
    // `default: undefined`; the whole sub-doc is replaced on each write (its two fields have no
    // siblings to protect). Never read by eligibility.
    marketingEmailConsent: {
      type: {
        updatedAt: { type: Date, required: true },
        source: { type: String, enum: marketingEmailConsentSources, required: true },
      },
      required: false,
      _id: false,
      default: undefined,
    },
    termsAcceptedAt: { type: Date },
    termsVersion: { type: String },
  },
  { timestamps: true },
);

userProfileSchema.index({ "phone.e164": 1 });
// Stage M3A — marketing campaign audience materialization scans exactly
// `{ "notifications.marketingEmail": true }`. Partial so it only indexes opted-in profiles (a
// small minority, since the product default is OFF) — never a generic index over every
// notification sub-field.
userProfileSchema.index(
  { "notifications.marketingEmail": 1 },
  { partialFilterExpression: { "notifications.marketingEmail": true } },
);

export const UserProfileModel = model<UserProfileDocument>("UserProfile", userProfileSchema);

/**
 * Minimal storage reference for the Customer's self-uploaded avatar — mirrors the fields
 * StaffAvatar keeps, minus `createdBy` (a Customer only ever uploads their own). The bytes
 * live in the S3-compatible object store under `storageKey`; nothing image-related (blob,
 * Base64, data URL) is ever persisted in Mongo. Absent until the Customer uploads one.
 */
export type CustomerAvatarMetadata = {
  storageKey: string;
  bucket: string;
  mimeType: string;
  size: number;
  updatedAt: Date;
};

export type CustomerProfileDocument = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  address?: string | undefined;
  dateOfBirth?: string | undefined;
  avatar?: CustomerAvatarMetadata | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const customerProfileSchema = new Schema<CustomerProfileDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    address: { type: String, trim: true },
    dateOfBirth: { type: String },
    avatar: {
      type: {
        storageKey: { type: String, required: true, trim: true },
        bucket: { type: String, required: true, trim: true },
        mimeType: { type: String, required: true, trim: true },
        size: { type: Number, required: true, min: 1 },
        updatedAt: { type: Date, required: true },
      },
      required: false,
      _id: false,
      default: undefined,
    },
  },
  { timestamps: true },
);

export const CustomerProfileModel = model<CustomerProfileDocument>(
  "CustomerProfile",
  customerProfileSchema,
);
