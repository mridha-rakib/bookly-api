import { describe, expect, it } from "vitest";

import { AuthError } from "../../src/modules/auth/auth.errors.js";
import { validateAndNormalizePhoneNumber } from "../../src/modules/auth/auth.utils.js";

// Regression coverage for the professional-signup "invalid phone reaches Twilio" bug: an
// implausible national number (e.g. a Bangladeshi mobile missing digits) previously passed
// normalizePhoneNumber's plain length check and only failed much later at the OTP provider.
// validateAndNormalizePhoneNumber is the country-aware layer in front of that — these tests use
// libphonenumber-js's own example-number semantics (isValid()), not a hand-written length table,
// across multiple numbering plans so this isn't a Bangladesh-only fix.
describe("validateAndNormalizePhoneNumber", () => {
  it("rejects the exact reproduced incomplete Bangladeshi number without persisting", () => {
    expect(() => validateAndNormalizePhoneNumber("+880", "19620260")).toThrow(AuthError);
    expect(() => validateAndNormalizePhoneNumber("+880", "19620260")).toThrow(
      expect.objectContaining({
        details: [expect.objectContaining({ code: "INVALID_PHONE_NUMBER" })],
      }),
    );
  });

  it("accepts a valid Bangladeshi mobile number and normalizes to canonical E.164", () => {
    const result = validateAndNormalizePhoneNumber("+880", "1712345678");
    expect(result).toEqual({
      countryCode: "+880",
      nationalNumber: "1712345678",
      e164: "+8801712345678",
    });
  });

  it("accepts a valid Cyprus mobile number", () => {
    const result = validateAndNormalizePhoneNumber("+357", "96123456");
    expect(result.e164).toBe("+35796123456");
  });

  it("rejects an implausibly short Cyprus number", () => {
    expect(() => validateAndNormalizePhoneNumber("+357", "123")).toThrow(
      expect.objectContaining({
        details: [expect.objectContaining({ code: "INVALID_PHONE_NUMBER" })],
      }),
    );
  });

  it("accepts a valid UK mobile number", () => {
    const result = validateAndNormalizePhoneNumber("+44", "7911123456");
    expect(result.e164).toBe("+447911123456");
  });

  it("accepts a valid NANP (+1) number without requiring a separate ISO country field", () => {
    // NANP is shared by the US, Canada, and multiple Caribbean territories under one calling
    // code — validated here purely from the full "+1<national>" string, proving an explicit ISO
    // region is not required for correct validation.
    const result = validateAndNormalizePhoneNumber("+1", "2015550123");
    expect(result.e164).toBe("+12015550123");
  });

  it("rejects a too-short NANP (+1) number", () => {
    expect(() => validateAndNormalizePhoneNumber("+1", "123")).toThrow(
      expect.objectContaining({
        details: [expect.objectContaining({ code: "INVALID_PHONE_NUMBER" })],
      }),
    );
  });

  it("rejects malformed arbitrary input that isn't even digit-shaped", () => {
    expect(() => validateAndNormalizePhoneNumber("+357", "abcxyz")).toThrow(
      expect.objectContaining({
        details: [expect.objectContaining({ code: "INVALID_PHONE_NUMBER" })],
      }),
    );
  });

  it("normalizes formatting variants of the same phone to the same E.164", () => {
    const plain = validateAndNormalizePhoneNumber("+44", "7911123456");
    const withSpaces = validateAndNormalizePhoneNumber("+44", "79 11 12 34 56");
    const withPunctuation = validateAndNormalizePhoneNumber("+44", "(791) 112-3456");

    expect(withSpaces.e164).toBe(plain.e164);
    expect(withPunctuation.e164).toBe(plain.e164);
  });
});
