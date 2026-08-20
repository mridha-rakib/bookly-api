import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUSINESS_TIMEZONE,
  isValidIanaTimeZone,
  resolveBusinessTimezone,
} from "../../src/common/time/timezone.js";

describe("isValidIanaTimeZone", () => {
  it("accepts real IANA zone identifiers", () => {
    expect(isValidIanaTimeZone("Europe/Nicosia")).toBe(true);
    expect(isValidIanaTimeZone("Europe/London")).toBe(true);
    expect(isValidIanaTimeZone("America/New_York")).toBe(true);
    expect(isValidIanaTimeZone("UTC")).toBe(true);
  });

  it("rejects unknown/garbage identifiers", () => {
    expect(isValidIanaTimeZone("Not/AZone")).toBe(false);
    expect(isValidIanaTimeZone("Foo/Bar")).toBe(false);
    expect(isValidIanaTimeZone("GMT+2")).toBe(false);
    expect(isValidIanaTimeZone("")).toBe(false);
    expect(isValidIanaTimeZone("   ")).toBe(false);
  });

  it("rejects non-string input without throwing", () => {
    expect(isValidIanaTimeZone(undefined as unknown as string)).toBe(false);
    expect(isValidIanaTimeZone(null as unknown as string)).toBe(false);
    expect(isValidIanaTimeZone(42 as unknown as string)).toBe(false);
  });
});

describe("resolveBusinessTimezone", () => {
  it("returns the given timezone when it is valid", () => {
    expect(resolveBusinessTimezone("Europe/London")).toBe("Europe/London");
  });

  it("falls back to Europe/Nicosia when undefined (legacy Business document)", () => {
    expect(resolveBusinessTimezone(undefined)).toBe(DEFAULT_BUSINESS_TIMEZONE);
  });

  it("falls back to Europe/Nicosia when the stored value is somehow invalid", () => {
    expect(resolveBusinessTimezone("Not/AZone")).toBe(DEFAULT_BUSINESS_TIMEZONE);
  });

  it("default constant is itself a valid IANA zone", () => {
    expect(isValidIanaTimeZone(DEFAULT_BUSINESS_TIMEZONE)).toBe(true);
    expect(DEFAULT_BUSINESS_TIMEZONE).toBe("Europe/Nicosia");
  });
});
