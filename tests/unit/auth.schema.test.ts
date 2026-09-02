import { describe, expect, it } from "vitest";

import {
  deleteMyAccountBodySchema,
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

  it("accepts defaultLanguage EN/GR and rejects any other value (Phase 1 — Super Admin Settings)", () => {
    expect(updateMyProfileBodySchema.safeParse({ defaultLanguage: "EN" }).success).toBe(true);
    expect(updateMyProfileBodySchema.safeParse({ defaultLanguage: "GR" }).success).toBe(true);
    expect(updateMyProfileBodySchema.safeParse({ defaultLanguage: "FR" }).success).toBe(false);
    expect(updateMyProfileBodySchema.safeParse({ defaultLanguage: "en" }).success).toBe(false);
  });

  describe("notifications (appointment reminder + marketing-email preferences)", () => {
    it("accepts a single-channel partial update", () => {
      expect(
        updateMyProfileBodySchema.safeParse({ notifications: { appointmentReminderEmail: false } })
          .success,
      ).toBe(true);
      expect(
        updateMyProfileBodySchema.safeParse({ notifications: { appointmentReminderSms: true } })
          .success,
      ).toBe(true);
    });

    it("accepts both channels together", () => {
      expect(
        updateMyProfileBodySchema.safeParse({
          notifications: { appointmentReminderEmail: true, appointmentReminderSms: false },
        }).success,
      ).toBe(true);
    });

    it("accepts a marketingEmail-only partial update (Stage M1)", () => {
      expect(
        updateMyProfileBodySchema.safeParse({ notifications: { marketingEmail: true } }).success,
      ).toBe(true);
      expect(
        updateMyProfileBodySchema.safeParse({ notifications: { marketingEmail: false } }).success,
      ).toBe(true);
    });

    it("rejects an empty notifications object (no-op request)", () => {
      expect(updateMyProfileBodySchema.safeParse({ notifications: {} }).success).toBe(false);
    });

    it("rejects a non-boolean channel value", () => {
      expect(
        updateMyProfileBodySchema.safeParse({ notifications: { appointmentReminderEmail: "yes" } })
          .success,
      ).toBe(false);
      expect(
        updateMyProfileBodySchema.safeParse({ notifications: { marketingEmail: "true" } }).success,
      ).toBe(false);
      expect(
        updateMyProfileBodySchema.safeParse({ notifications: { marketingEmail: null } }).success,
      ).toBe(false);
    });

    it("rejects an unknown nested channel key (mass-assignment guard)", () => {
      expect(
        updateMyProfileBodySchema.safeParse({ notifications: { newsletter: true } }).success,
      ).toBe(false);
      expect(
        updateMyProfileBodySchema.safeParse({
          notifications: { marketingEmail: true, bogus: 1 },
        }).success,
      ).toBe(false);
    });
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

describe("deleteMyAccountBodySchema", () => {
  it("accepts currentPassword + the literal DELETE confirmation", () => {
    expect(
      deleteMyAccountBodySchema.safeParse({
        currentPassword: "secret",
        confirmationText: "DELETE",
      }).success,
    ).toBe(true);
  });

  it("accepts an optional deletionReason", () => {
    const result = deleteMyAccountBodySchema.safeParse({
      currentPassword: "secret",
      confirmationText: "DELETE",
      deletionReason: "Moving away",
    });
    expect(result.success).toBe(true);
  });

  it("rejects any confirmationText other than the exact word DELETE", () => {
    expect(
      deleteMyAccountBodySchema.safeParse({ currentPassword: "secret", confirmationText: "delete" })
        .success,
    ).toBe(false);
    expect(
      deleteMyAccountBodySchema.safeParse({ currentPassword: "secret", confirmationText: "" })
        .success,
    ).toBe(false);
    expect(deleteMyAccountBodySchema.safeParse({ currentPassword: "secret" }).success).toBe(false);
  });

  it("requires a non-empty currentPassword", () => {
    expect(
      deleteMyAccountBodySchema.safeParse({ currentPassword: "", confirmationText: "DELETE" })
        .success,
    ).toBe(false);
  });

  it("rejects unknown fields (mass-assignment guard) and an over-long reason", () => {
    expect(
      deleteMyAccountBodySchema.safeParse({
        currentPassword: "secret",
        confirmationText: "DELETE",
        status: "ACTIVE",
      }).success,
    ).toBe(false);
    expect(
      deleteMyAccountBodySchema.safeParse({
        currentPassword: "secret",
        confirmationText: "DELETE",
        deletionReason: "x".repeat(501),
      }).success,
    ).toBe(false);
  });
});
