import { describe, expect, it } from "vitest";

import {
  requestEmailChangeBodySchema,
  requestPhoneChangeBodySchema,
  updateMyProfileBodySchema,
  verifyEmailChangeBodySchema,
  verifyPhoneChangeBodySchema,
} from "../../src/modules/auth/auth.schema.js";

describe("updateMyProfileBodySchema", () => {
  it("accepts the allow-listed profile fields", () => {
    const result = updateMyProfileBodySchema.safeParse({ firstName: "Jane", address: "Nicosia" });
    expect(result.success).toBe(true);
  });

  it("rejects direct email mass-assignment (Batch 18 — email must go through the change/verify flow)", () => {
    const result = updateMyProfileBodySchema.safeParse({ email: "new@example.com" });
    expect(result.success).toBe(false);
  });

  it("rejects direct phone mass-assignment (Batch 18 — phone must go through the change/verify flow)", () => {
    const result = updateMyProfileBodySchema.safeParse({
      phone: { countryCode: "+357", nationalNumber: "12345678" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects role/status/internal-id mass-assignment", () => {
    expect(updateMyProfileBodySchema.safeParse({ role: "SUPER_ADMIN" }).success).toBe(false);
    expect(updateMyProfileBodySchema.safeParse({ status: "SUSPENDED" }).success).toBe(false);
    expect(updateMyProfileBodySchema.safeParse({ _id: "000000000000000000000000" }).success).toBe(
      false,
    );
  });
});

describe("Batch 18 contact-change schemas", () => {
  it("requestEmailChangeBodySchema requires currentPassword + a valid newEmail", () => {
    expect(
      requestEmailChangeBodySchema.safeParse({
        currentPassword: "secret",
        newEmail: "new@example.com",
      }).success,
    ).toBe(true);
    expect(requestEmailChangeBodySchema.safeParse({ newEmail: "new@example.com" }).success).toBe(
      false,
    );
    expect(
      requestEmailChangeBodySchema.safeParse({
        currentPassword: "secret",
        newEmail: "not-an-email",
      }).success,
    ).toBe(false);
  });

  it("verifyEmailChangeBodySchema requires exactly a 4-digit code", () => {
    expect(verifyEmailChangeBodySchema.safeParse({ code: "1234" }).success).toBe(true);
    expect(verifyEmailChangeBodySchema.safeParse({ code: "12345" }).success).toBe(false);
    expect(verifyEmailChangeBodySchema.safeParse({}).success).toBe(false);
  });

  it("requestPhoneChangeBodySchema requires currentPassword + countryCode + nationalNumber", () => {
    expect(
      requestPhoneChangeBodySchema.safeParse({
        currentPassword: "secret",
        countryCode: "+357",
        nationalNumber: "12345678",
      }).success,
    ).toBe(true);
    expect(
      requestPhoneChangeBodySchema.safeParse({ countryCode: "+357", nationalNumber: "12345678" })
        .success,
    ).toBe(false);
  });

  it("verifyPhoneChangeBodySchema requires exactly a 4-digit code", () => {
    expect(verifyPhoneChangeBodySchema.safeParse({ code: "5678" }).success).toBe(true);
    expect(verifyPhoneChangeBodySchema.safeParse({ code: "abcd" }).success).toBe(false);
  });
});
