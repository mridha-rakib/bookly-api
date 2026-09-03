import { model, Schema, type Types } from "mongoose";

import { type LinkedAccountProvider, linkedAccountProviders } from "./linked-account.types.js";

/**
 * A verified external identity (Phase 1: Google only) linked to a Bookly `User`. Tokens are
 * NEVER stored — the OAuth `code` is exchanged once at link time purely to verify the provider
 * identity (see google-oauth.client.ts), then discarded. This model only records who the linked
 * account is, not any credential to act as them.
 */
export type LinkedAccountDocument = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  provider: LinkedAccountProvider;
  /** The provider's stable subject identifier (Google OIDC `sub`). Never the email. */
  providerAccountId: string;
  /** The provider-asserted email at link time — display only, never used to resolve a user. */
  email: string;
  emailVerified: boolean;
  displayName?: string | undefined;
  linkedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const linkedAccountSchema = new Schema<LinkedAccountDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    provider: { type: String, enum: linkedAccountProviders, required: true },
    providerAccountId: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    emailVerified: { type: Boolean, required: true, default: false },
    displayName: { type: String, trim: true },
    linkedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// One external identity maps to at most one Bookly user — blocks linking the same Google
// account to a second account (LINKED_ACCOUNT_ALREADY_LINKED_ELSEWHERE).
linkedAccountSchema.index({ provider: 1, providerAccountId: 1 }, { unique: true });
// At most one linked account per provider per user — a user cannot accumulate multiple Google
// links (LINKED_ACCOUNT_PROVIDER_ALREADY_LINKED). Also serves findByUserId via the userId prefix.
linkedAccountSchema.index({ userId: 1, provider: 1 }, { unique: true });

export const LinkedAccountModel = model<LinkedAccountDocument>(
  "LinkedAccount",
  linkedAccountSchema,
);
