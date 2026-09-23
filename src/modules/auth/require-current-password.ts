import { AuthError } from "./auth.errors.js";
import type { PasswordHasher } from "./password-hasher.js";

/** The minimum a caller must hand over — deliberately structural, so this helper works for a
 * `UserDocument` read through `findByIdWithPassword` without importing the user module. */
type UserWithPasswordHash = {
  passwordHash?: string | undefined;
};

/**
 * The single "prove you know your current password" step-up check.
 *
 * Extracted because this exact three-line shape — `verify(user.passwordHash, currentPassword)`,
 * then `throw new AuthError("INVALID_CURRENT_PASSWORD", 400)` — was duplicated inline in four
 * AuthService methods (changeMyPassword, deleteMyAccount, requestEmailChange, requestPhoneChange)
 * and is now needed by a fifth, unrelated module (payout-destination). Behaviour is byte-identical
 * to every one of those inline checks, including the two properties the payout flow relies on:
 *
 *  - `PasswordHasher.verify` treats an ABSENT hash as a non-match (see its own doc comment), so
 *    an OAuth-only account can never satisfy this check by accident;
 *  - an absent/empty `password` argument is rejected with the SAME error as a wrong password, so
 *    a caller can never distinguish "you sent nothing" from "you sent the wrong thing".
 *
 * It intentionally does NOT check whether the account has a PASSWORD auth provider — callers that
 * want the clearer `PASSWORD_NOT_CONFIGURED` signal (AuthService.changeMyPassword,
 * PayoutDestinationService) check that themselves first, and callers that want a wrong-password
 * answer for a passwordless account get exactly that.
 */
export const requireCurrentPassword = async (
  passwordHasher: PasswordHasher,
  user: UserWithPasswordHash,
  password: string | undefined,
): Promise<void> => {
  if (!password || !(await passwordHasher.verify(user.passwordHash, password))) {
    throw new AuthError("INVALID_CURRENT_PASSWORD", 400);
  }
};
