import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import type { PhoneNumber } from "../user/user.types.js";

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

export const addDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
