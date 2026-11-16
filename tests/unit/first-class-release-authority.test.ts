import { afterEach, expect, it, vi } from "vitest";
import { syntheticConsentHost } from "../helpers/consent-host-fixture.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform");
if (!platform) throw new Error("process platform descriptor missing");
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.doUnmock("../../src/modules/booking/trusted-time/require-qualified-linux-boot.js");
  vi.doUnmock("../../src/modules/booking/approved-first-class-release.js");
  vi.doUnmock("../../src/modules/booking/trusted-time/approved-consent-host-input.js");
  vi.resetModules();
});

it("admits only the explicitly approved synthetic issuer on the approved Linux boot", async () => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const { auditKey, ...profile } = syntheticConsentHost;
  let boot = profile.approvedBootId;
  let available = true;
  let lifetimeMs = 1_800_000;
  let authorityId = profile.authorityId;
  vi.doMock("../../src/modules/booking/trusted-time/require-qualified-linux-boot.js", () => ({
    requireQualifiedLinuxBoot: async () => {
      if (boot !== profile.approvedBootId) throw new Error("synthetic boot mismatch");
    },
  }));
  vi.doMock("../../src/modules/booking/approved-first-class-release.js", () => ({
    readApprovedFirstClassRelease: () => ({
      version: 1,
      approvalReference: "synthetic-release",
      lifetimeMs,
      authorityId,
      hostId: profile.hostId,
      configurationHash: profile.configurationHash,
      approvedBootId: profile.approvedBootId,
    }),
  }));
  vi.doMock("../../src/modules/booking/trusted-time/approved-consent-host-input.js", () => ({
    approvedConsentHostInput: {
      policy: {
        version: 1,
        approvalReference: "synthetic-policy",
        maxAcquireMs: profile.maxAcquireMs,
        maxSampleAgeMs: profile.maxSampleAgeMs,
        maxErrorMs: profile.maxErrorMs,
        maxDriftPpm: profile.maxDriftPpm,
        minRemainingMs: profile.minRemainingMs,
      },
      entries: [
        {
          version: 1,
          qualificationReference: "synthetic-only",
          chronycSha256: "a".repeat(64),
          chronydSha256: "b".repeat(64),
          profile,
          keyReference: "test",
          keyVersion: "v1",
          disposition: "CURRENT",
        },
      ],
      resolveProtectedKey: () => {
        if (!available) throw new Error("unavailable");
        return Buffer.from(auditKey);
      },
    },
  }));
  const { verifyPackageBatchActivation } = await import(
    "../../src/modules/booking/package-batch-authority.js"
  );
  await expect(verifyPackageBatchActivation()).resolves.toBeUndefined();
  lifetimeMs = 1_799_999;
  await expect(verifyPackageBatchActivation()).rejects.toMatchObject({
    code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE",
  });
  lifetimeMs = 1_800_000;
  authorityId = "other-authority";
  await expect(verifyPackageBatchActivation()).rejects.toMatchObject({
    code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE",
  });
  authorityId = profile.authorityId;
  boot = "bbbb2222-2222-4222-8222-222222222222";
  await expect(verifyPackageBatchActivation()).rejects.toMatchObject({
    code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE",
  });
  boot = profile.approvedBootId;
  available = false;
  await expect(verifyPackageBatchActivation()).rejects.toMatchObject({
    code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE",
  });
});
