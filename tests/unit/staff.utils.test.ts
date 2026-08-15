import { describe, expect, it } from "vitest";

import {
  generateTempPassword,
  joinStaffName,
  parseFreeTextPhone,
  splitStaffName,
} from "../../src/modules/staff/staff.utils.js";

describe("staff.utils", () => {
  describe("generateTempPassword", () => {
    it("is not a static/predictable value and never equals the legacy UI copy literal", () => {
      const passwords = Array.from({ length: 50 }, () => generateTempPassword());

      for (const password of passwords) {
        expect(password).not.toBe("123456");
        expect(password.length).toBe(16);
      }

      expect(new Set(passwords).size).toBe(passwords.length);
    });

    it("includes at least one character from each required category", () => {
      for (let i = 0; i < 20; i += 1) {
        const password = generateTempPassword();
        expect(password).toMatch(/[A-Z]/);
        expect(password).toMatch(/[a-z]/);
        expect(password).toMatch(/[0-9]/);
        expect(password).toMatch(/[!@#$%^&*\-_=+]/);
      }
    });
  });

  describe("splitStaffName / joinStaffName", () => {
    it("round-trips a multi-word name exactly", () => {
      const { firstName, lastName } = splitStaffName("Vivi Marchetti");
      expect(firstName).toBe("Vivi");
      expect(lastName).toBe("Marchetti");
      expect(joinStaffName(firstName, lastName)).toBe("Vivi Marchetti");
    });

    it("round-trips a single-token name without corrupting the visible name", () => {
      const { firstName, lastName } = splitStaffName("Cher");
      expect(firstName).toBe("Cher");
      expect(lastName).toBe("Cher");
      expect(joinStaffName(firstName, lastName)).toBe("Cher");
    });

    it("collapses extra whitespace and keeps the remainder joined for 3+ word names", () => {
      const { firstName, lastName } = splitStaffName("  Mary   Jane   Watson ");
      expect(firstName).toBe("Mary");
      expect(lastName).toBe("Jane Watson");
      expect(joinStaffName(firstName, lastName)).toBe("Mary Jane Watson");
    });
  });

  describe("parseFreeTextPhone", () => {
    it("parses a valid free-text phone into the structured shape", () => {
      const phone = parseFreeTextPhone("+357 99 111222");
      expect(phone).toEqual({
        countryCode: "+357",
        nationalNumber: "99111222",
        e164: "+35799111222",
      });
    });

    it("returns undefined for an empty/omitted value", () => {
      expect(parseFreeTextPhone(undefined)).toBeUndefined();
      expect(parseFreeTextPhone("")).toBeUndefined();
      expect(parseFreeTextPhone("   ")).toBeUndefined();
    });

    it("throws for a non-empty value that doesn't parse as a phone number", () => {
      expect(() => parseFreeTextPhone("not-a-phone")).toThrow();
      expect(() => parseFreeTextPhone("12345")).toThrow();
    });
  });
});
