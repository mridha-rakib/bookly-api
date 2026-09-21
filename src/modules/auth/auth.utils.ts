import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import { parsePhoneNumberFromString } from "libphonenumber-js";

import { env } from "../../config/env.js";
import type { PhoneNumber } from "../user/user.types.js";
import { AuthError } from "./auth.errors.js";

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const generateNumericOtp = (length: number): string => {
  let otp = "";
  for (let index = 0; index < length; index += 1) {
    otp += String(randomInt(0, 10));
  }
  return otp;
};

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export const safeCompare = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
};

export const createOpaqueToken = (): string => randomBytes(48).toString("base64url");

export const normalizePhoneNumber = (countryCode: string, nationalNumber: string): PhoneNumber => {
  const normalizedCountryCode = countryCode.trim().replace(/[^\d+]/g, "");
  const normalizedNationalNumber = nationalNumber.trim().replace(/\D/g, "");

  if (!/^\+\d{1,4}$/.test(normalizedCountryCode) || normalizedNationalNumber.length < 4) {
    throw new Error("Invalid phone number");
  }

  return {
    countryCode: normalizedCountryCode,
    nationalNumber: normalizedNationalNumber,
    e164: `${normalizedCountryCode}${normalizedNationalNumber}`,
  };
};

// Country-aware structural validation on top of normalizePhoneNumber's plain digit-grouping —
// used only where a malformed number reaching Twilio is the actual bug (professional
// submitProfile / changeProfessionalPhone), not by every normalizePhoneNumber caller, so this
// doesn't change behavior for business/staff/client phone fields out of scope for that fix.
//
// A calling code alone (e.g. "+1") doesn't uniquely identify a country (NANP alone covers the US,
// Canada, and over a dozen Caribbean territories), so this deliberately does NOT ask the caller
// for an ISO country — libphonenumber-js derives the specific numbering plan (and therefore the
// correct length/prefix rules) directly from the full "+<callingCode><nationalNumber>" string,
// the same way a real dial would be routed.
//
// Uses isValid() (structural validity against the matched country's numbering plan), not a
// MOBILE-type check: libphonenumber-js's line-type classification is unreliable for a meaningful
// share of countries (many ranges are ambiguous or unclassified in its metadata), so requiring
// MOBILE would false-reject legitimate numbers in exactly the countries where we can least afford
// friction. Rejecting the merely "possible" (right length range, still not a valid number) case
// that normalizePhoneNumber lets through is deliberate; +88019620260 is a real example — 8 digits
// is "possible" for Bangladesh but not a valid number.
export const validateAndNormalizePhoneNumber = (
  countryCode: string,
  nationalNumber: string,
): PhoneNumber => {
  let candidate: PhoneNumber;
  try {
    candidate = normalizePhoneNumber(countryCode, nationalNumber);
  } catch {
    throw new AuthError("INVALID_PHONE_NUMBER", 400);
  }

  const parsed = parsePhoneNumberFromString(candidate.e164);

  if (!parsed || !parsed.isValid()) {
    throw new AuthError("INVALID_PHONE_NUMBER", 400);
  }

  return {
    countryCode: `+${parsed.countryCallingCode}`,
    nationalNumber: parsed.nationalNumber,
    e164: parsed.number,
  };
};

export const addMinutes = (date: Date, minutes: number): Date =>
  new Date(date.getTime() + minutes * 60 * 1000);

export const addSeconds = (date: Date, seconds: number): Date =>
  new Date(date.getTime() + seconds * 1000);

export const addDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

const oneHourMs = 60 * 60 * 1000;

// Shared OTP resend policy: any OTP-issuing flow (registration email/phone, business-link
// verification, ...) can reuse this instead of duplicating the cooldown/hourly-limit checks.
export const pruneRecentTimestamps = (timestamps: Date[], windowMs: number): Date[] => {
  const cutoff = Date.now() - windowMs;
  return timestamps.filter((timestamp) => timestamp.getTime() >= cutoff);
};

export const assertOtpResendAllowed = (timestamps: Date[], sentAt?: Date): void => {
  const now = new Date();

  if (sentAt && now.getTime() - sentAt.getTime() < env.OTP_RESEND_COOLDOWN_SECONDS * 1000) {
    throw new AuthError("OTP_RESEND_COOLDOWN", 429);
  }

  if (pruneRecentTimestamps(timestamps, oneHourMs).length >= env.OTP_MAX_RESENDS_PER_HOUR) {
    throw new AuthError("OTP_RESEND_LIMIT_EXCEEDED", 429);
  }
};
