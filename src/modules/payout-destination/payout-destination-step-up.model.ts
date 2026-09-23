import { type HydratedDocument, model, Schema, type Types } from "mongoose";

/**
 * OAuth-only Business Owner step-up for a payout-destination change.
 *
 * WHY A PARALLEL MODEL RATHER THAN A THIRD `contactChangePurposes` VALUE (deliberate decision):
 * ContactChangeChallenge is, by its own doc comment, "the smallest purpose-specific shape" for an
 * authenticated user changing ONE PIECE OF CONTACT INFO. Three concrete mismatches, not just
 * naming taste:
 *   1. Its uniqueness key is `(userId, purpose)`. A payout step-up must be bound to
 *      `(userId, businessId)` — the proof has to name which Business it authorizes, or an Owner
 *      could carry a proof minted for one Business onto another.
 *   2. Its repository's write surface is email/phone-specific (`upsertEmailChallenge` /
 *      `upsertPhoneChallenge`, each `$unset`-ing the other's fields) and its schema carries
 *      `newNormalizedEmail` / `newPhone` / `providerVerificationId`, none of which a payout
 *      challenge has or should be able to set.
 *   3. `ContactChangeChallengeRepository.deleteAllForUser` is invoked by Customer account
 *      closure; a payout challenge has no business being coupled to that lifecycle.
 * Adding `"PAYOUT_DESTINATION_CHANGE"` there would have meant a purpose whose row is shaped
 * wrong, keyed wrong, and cleaned up by an unrelated flow. The conventions it established
 * (hashed OTP with `select: false`, `expiresAt` + TTL index, `attempts` cap, `resendTimestamps`,
 * one active slot per subject enforced by a unique index, atomic claim-and-delete) are copied
 * here EXACTLY.
 *
 * PURPOSE ISOLATION is therefore structural rather than a string comparison: a
 * PAYOUT_DESTINATION_CHANGE code lives in a different COLLECTION from every contact-change code,
 * so it cannot be submitted to `POST /auth/me/email/verify` (which only ever queries
 * ContactChangeChallenge) and a contact-change code can never satisfy this flow. The `purpose`
 * field is retained anyway as a stored, enum-constrained invariant and as room for a future
 * second payout-scoped purpose.
 *
 * The row has two phases in ONE document, which is what makes the issued proof single-use:
 *   PHASE 1 (request): `otpHash` + `otpExpiresAt` set, `authorizationTokenHash` absent.
 *   PHASE 2 (verify):  the OTP fields are cleared and `authorizationTokenHash` +
 *                      `authorizationExpiresAt` are set.
 * Consuming the proof DELETES the row (see the repository's `consumeAuthorization`), so a replay
 * finds nothing. Only the SHA-256 of the token is ever stored, never the token itself.
 */
export const payoutStepUpPurposes = ["PAYOUT_DESTINATION_CHANGE"] as const;
export type PayoutStepUpPurpose = (typeof payoutStepUpPurposes)[number];

export type PayoutDestinationStepUpChallenge = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  businessId: Types.ObjectId;
  purpose: PayoutStepUpPurpose;
  /** SHA-256(OTP + OTP_HASH_SECRET) — same hashing helper the registration/email-change OTP
   * flows use. Cleared once the OTP has been verified. */
  otpHash?: string | undefined;
  otpExpiresAt?: Date | undefined;
  /** SHA-256 of the opaque single-use authorization token handed to the client on verify. */
  authorizationTokenHash?: string | undefined;
  authorizationExpiresAt?: Date | undefined;
  attempts: number;
  resendTimestamps: Date[];
  sentAt?: Date | undefined;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type PayoutDestinationStepUpChallengeDocument =
  HydratedDocument<PayoutDestinationStepUpChallenge>;

const payoutDestinationStepUpChallengeSchema = new Schema<PayoutDestinationStepUpChallenge>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    purpose: { type: String, enum: payoutStepUpPurposes, required: true },
    otpHash: { type: String, select: false },
    otpExpiresAt: { type: Date },
    authorizationTokenHash: { type: String, select: false },
    authorizationExpiresAt: { type: Date },
    attempts: { type: Number, required: true, default: 0 },
    resendTimestamps: { type: [Date], required: true, default: [] },
    sentAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// One active step-up slot per (user, business, purpose) — a fresh request overwrites it, exactly
// as ContactChangeChallenge's `(userId, purpose)` index does, so "multiple uncontrolled active
// challenges" stays structurally impossible.
payoutDestinationStepUpChallengeSchema.index(
  { userId: 1, businessId: 1, purpose: 1 },
  { unique: true },
);
// Same TTL convention as ContactChangeChallenge — bounded storage, no cleanup job.
payoutDestinationStepUpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PayoutDestinationStepUpChallengeModel = model<PayoutDestinationStepUpChallenge>(
  "PayoutDestinationStepUpChallenge",
  payoutDestinationStepUpChallengeSchema,
);
