import { randomInt } from "node:crypto";

import { normalizePhoneNumber } from "../auth/auth.utils.js";
import type { PhoneNumber } from "../user/user.types.js";

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O (visual ambiguity with 1/0)
const LOWER = "abcdefghijkmnopqrstuvwxyz"; // no l
const DIGIT = "23456789"; // no 0/1
const SYMBOL = "!@#$%^&*-_=+";
const ALL = UPPER + LOWER + DIGIT + SYMBOL;

const pick = (charset: string): string => charset[randomInt(0, charset.length)] as string;

/**
 * Cryptographically secure temporary password for newly created SUPERVISOR/STAFF
 * accounts. Never derived from Math.random(), email, name, or phone, and never a
 * static/shared value. Callers must hash it immediately and discard the plaintext
 * after handing it to the email provider — never persist, log, or return it.
 */
export const generateTempPassword = (length = 16): string => {
  const required = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  const rest = Array.from({ length: Math.max(length - required.length, 0) }, () => pick(ALL));
  const chars = [...required, ...rest];

  // Fisher-Yates shuffle using a CSPRNG so the guaranteed-category characters aren't
  // predictably placed at the start of the string.
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(0, index + 1);
    [chars[index], chars[swapIndex]] = [chars[swapIndex] as string, chars[index] as string];
  }

  return chars.join("");
};

export type SplitName = { firstName: string; lastName: string };

/**
 * The Add Staff form has a single free-text "Name" field, but UserProfile requires
 * non-empty firstName/lastName. Split on the first whitespace boundary; for a single
 * token (no space), duplicate it into both fields so Mongoose's required validators are
 * satisfied without inventing a placeholder — {@link joinStaffName} below undoes the
 * duplication so the *displayed* name always exactly matches what was typed.
 */
export const splitStaffName = (fullName: string): SplitName => {
  const trimmed = fullName.trim().replace(/\s+/g, " ");
  const firstSpace = trimmed.indexOf(" ");

  if (firstSpace === -1) {
    return { firstName: trimmed, lastName: trimmed };
  }

  return {
    firstName: trimmed.slice(0, firstSpace),
    lastName: trimmed.slice(firstSpace + 1),
  };
};

/** Inverse of {@link splitStaffName} — collapses the single-token duplication back down. */
export const joinStaffName = (firstName: string, lastName: string): string =>
  firstName === lastName ? firstName : `${firstName} ${lastName}`;

/**
 * The Add Staff form has a single free-text phone field (e.g. "+357 99 111222"), unlike
 * the structured countryCode/nationalNumber inputs used elsewhere in the app. Parses that
 * free text into the same normalized shape the rest of the app uses, reusing
 * auth.utils.normalizePhoneNumber's validation. Returns undefined for an empty/omitted
 * value (phone is optional); throws Error for a non-empty value that doesn't parse.
 */
export const parseFreeTextPhone = (raw: string | undefined): PhoneNumber | undefined => {
  const trimmed = raw?.trim();

  if (!trimmed) {
    return undefined;
  }

  const match = /^(\+\d{1,4})[\s-]*(\d[\d\s-]{3,})$/.exec(trimmed);

  if (!match) {
    throw new Error("Invalid phone number");
  }

  const [, countryCode, nationalPart] = match as unknown as [string, string, string];
  return normalizePhoneNumber(countryCode, nationalPart);
};
