import { afterEach, expect, it, vi } from "vitest";
import { APPROVED_CONSENT_TIME_AUTHORITIES } from "../../src/modules/booking/package-consent-commit-deadline.js";
import { observeConsentHost } from "../../src/modules/booking/trusted-time/host-clock.js";
import {
  requireConsentHostVerificationProfile,
  requireQualifiedConsentHost,
} from "../../src/modules/booking/trusted-time/qualified-host.js";

afterEach(() => vi.unstubAllEnvs());
it("source approval is not host qualification, a numerical bound or production clock approval", async () => {
  vi.stubEnv("PACKAGE_CONSENT_ENABLED", "true");
  expect(() => requireQualifiedConsentHost()).toThrow("qualification");
  await expect(observeConsentHost("a".repeat(64))).rejects.toMatchObject({ statusCode: 503 });
  expect(APPROVED_CONSENT_TIME_AUTHORITIES).toEqual([]);
  expect(() =>
    requireConsentHostVerificationProfile({
      authorityId: "posted-authority",
      hostId: "posted-host",
      configurationHash: "a".repeat(64),
      approvedBootId: "aaaa1111-1111-4111-8111-111111111111",
    }),
  ).toThrow("unavailable");
});
