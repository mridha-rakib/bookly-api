import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
const load = () => import("../../src/config/env.js");
it.each([
  [undefined, 1800000],
  ["", 1800000],
  ["600000", 600000],
  ["900000", 900000],
  ["1800000", 1800000],
])("TTL %s resolves to %s milliseconds", async (value, expected) => {
  vi.stubEnv("PACKAGE_CONSENT_QUOTE_LIFETIME_MS", value);
  vi.resetModules();
  expect((await load()).env.PACKAGE_CONSENT_QUOTE_LIFETIME_MS).toBe(expected);
});
it.each(["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "garbage"])(
  "TTL %s fails configuration closed",
  async (value) => {
    vi.stubEnv("PACKAGE_CONSENT_QUOTE_LIFETIME_MS", value);
    vi.resetModules();
    await expect(load()).rejects.toThrow("Invalid environment configuration");
  },
);
it("absent server flag defaults OFF", async () => {
  vi.stubEnv("PACKAGE_CONSENT_ENABLED", undefined);
  vi.resetModules();
  expect((await load()).env.PACKAGE_CONSENT_ENABLED).toBe(false);
});
it("unknown server flag fails startup", async () => {
  vi.stubEnv("PACKAGE_CONSENT_ENABLED", "enabled");
  vi.resetModules();
  await expect(load()).rejects.toThrow("Invalid environment configuration");
});
