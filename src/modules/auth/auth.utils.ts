import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

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
