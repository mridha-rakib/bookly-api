import { type HydratedDocument, model, Schema, type Types } from "mongoose";

import {
  type PayoutDestinationHistoryEntry,
  payoutDestinationHistoryActions,
} from "./payout-destination.types.js";

/**
 * The single bank destination a Business is paid out to — ONE per Business, enforced structurally
 * by a unique index on `businessId` (not by policy). A Business Owner creating a "second"
 * destination REPLACES the existing one; there is no multi-account model, no DELETE path and no
 * status field: absence of this document IS "not configured", presence IS "configured". No
 * VERIFIED/APPROVED state is invented here — Bookly performs no bank verification.
 *
 * This module only ever STORES and READS destination data. It can never move money: no transfer,
 * withdrawal or payout is triggerable from any route in it. The authoritative payout write path
 * remains BusinessPayoutService.executePayout (Super Admin only), which merely SNAPSHOTS safe
 * metadata from here at confirm time.
 *
 * At-rest protection (mirrors the Google Calendar token-at-rest precedent, but with its own key
 * and its own generic primitive — see common/crypto/aes-256-gcm-secret.ts):
 *  - the IBAN is stored ONLY as AES-256-GCM ciphertext + IV + auth tag, never in plaintext and
 *    never in its original user-typed spacing (it is normalized before encryption);
 *  - those three fields are `select: false`, matching ContactChangeChallenge's `otpHash` and
 *    User's `passwordHash` — an ordinary read of this collection cannot return them at all, so
 *    a forgotten `.select()` fails closed rather than leaking;
 *  - `ibanKeyVersion` records WHICH key encrypted this row, so a future key rotation never has
 *    to re-encrypt existing rows. An unknown version at decrypt time throws (fail closed) and is
 *    never treated as "not configured";
 *  - `businessId` is used as GCM additional authenticated data, so a ciphertext copied onto
 *    another Business's document fails its auth-tag check instead of decrypting.
 *
 * `ibanLast4` / `ibanCountry` are DERIVED from the normalized IBAN by the service (never
 * client-supplied) and are the only IBAN-shaped values any read path is allowed to return.
 */
export type PayoutDestination = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  /** A required, dedicated field — deliberately NOT defaulted or derived from `Business.name`
   * or `Business.ownerName`: the legal account holder at the bank is frequently neither. */
  accountHolderName: string;
  ibanCiphertext: string;
  ibanIv: string;
  ibanAuthTag: string;
  ibanKeyVersion: number;
  /** Last 4 characters of the NORMALIZED IBAN. */
  ibanLast4: string;
  /** First 2 characters (ISO country) of the NORMALIZED IBAN. */
  ibanCountry: string;
  /** Free text exactly as the Owner typed it (trimmed) — never derived from the IBAN's BIC. */
  bankName?: string | undefined;
  history: PayoutDestinationHistoryEntry[];
  lastUpdatedByUserId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export type PayoutDestinationDocument = HydratedDocument<PayoutDestination>;

/** The exact projection needed to decrypt — used ONLY by the reveal path. */
export const PAYOUT_DESTINATION_SECRET_SELECT = "+ibanCiphertext +ibanIv +ibanAuthTag";

const payoutDestinationSchema = new Schema<PayoutDestination>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    accountHolderName: { type: String, required: true, trim: true, maxlength: 200 },
    ibanCiphertext: { type: String, required: true, select: false },
    ibanIv: { type: String, required: true, select: false },
    ibanAuthTag: { type: String, required: true, select: false },
    ibanKeyVersion: { type: Number, required: true },
    ibanLast4: { type: String, required: true },
    ibanCountry: { type: String, required: true, uppercase: true },
    bankName: { type: String, trim: true, maxlength: 200 },
    history: {
      type: [
        {
          _id: false,
          action: { type: String, enum: payoutDestinationHistoryActions, required: true },
          actorUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
          changedAt: { type: Date, required: true },
          previousLast4: { type: String },
          newLast4: { type: String },
        },
      ],
      required: true,
      default: [],
    },
    lastUpdatedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

// One Business = one payout destination. Structural, not policy: a concurrent double-submit
// cannot create a second row, it collides here and the repository's upsert resolves to an update.
payoutDestinationSchema.index({ businessId: 1 }, { unique: true });

export const PayoutDestinationModel = model<PayoutDestination>(
  "BusinessPayoutDestination",
  payoutDestinationSchema,
);
