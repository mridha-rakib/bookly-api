import { z } from "zod";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

/** Mirrors financeBusinessParamsSchema exactly — the route is mounted alongside finance's. */
export const payoutDestinationBusinessParamsSchema = z
  .object({ businessId: objectIdSchema })
  .strict();

/**
 * The step-up proof a payout-destination write must carry. Exactly one of the two branches is
 * used, decided SERVER-side from the actor's own `hasPassword`:
 *  - password accounts send `currentPassword`;
 *  - OAuth-only accounts send `otpAuthorizationToken` (from the two-step OTP flow below).
 * Both are optional HERE because the schema cannot know which kind of account is calling;
 * PayoutDestinationService enforces the right one and rejects the wrong one.
 */
const stepUpSchema = z
  .object({
    currentPassword: z.string().min(1).max(200).optional(),
    otpAuthorizationToken: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * Create-or-replace body. `.strict()` is what rejects any client-supplied `ibanLast4`,
 * `ibanCountry`, `ibanKeyVersion`, `ibanCiphertext`, `history`, `businessId` or `ownerUserId`:
 * those are ALWAYS backend-derived, and an unknown key here is a 400 rather than being silently
 * dropped. There is no `status` field and no VAT field of any kind.
 */
export const updatePayoutDestinationBodySchema = z
  .object({
    accountHolderName: z.string().trim().min(1).max(200),
    // Length bounds only — normalization + mod-97 validation happen in the service (see
    // payout-destination.iban.ts), because the stored/derived values must come from the SAME
    // canonical string that gets encrypted.
    iban: z.string().min(5).max(64),
    bankName: z.string().trim().min(1).max(200).optional(),
    stepUp: stepUpSchema,
  })
  .strict();

export const requestPayoutStepUpOtpBodySchema = z.object({}).strict();

export const verifyPayoutStepUpOtpBodySchema = z
  .object({
    code: z.string().trim().min(4).max(10),
  })
  .strict();

export type PayoutDestinationBusinessParams = z.infer<typeof payoutDestinationBusinessParamsSchema>;
export type UpdatePayoutDestinationBody = z.infer<typeof updatePayoutDestinationBodySchema>;
export type VerifyPayoutStepUpOtpBody = z.infer<typeof verifyPayoutStepUpOtpBodySchema>;
