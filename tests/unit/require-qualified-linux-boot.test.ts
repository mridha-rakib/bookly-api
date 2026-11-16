import { afterEach, expect, it, vi } from "vitest";
import { syntheticConsentHost } from "../helpers/consent-host-fixture.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform");
if (!platform) throw new Error("process platform descriptor missing");
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
});

it("requires Linux and the exact qualified boot", async () => {
  let boot = syntheticConsentHost.approvedBootId;
  vi.doMock("node:fs/promises", () => ({ readFile: async () => boot }));
  const { requireQualifiedLinuxBoot } = await import(
    "../../src/modules/booking/trusted-time/require-qualified-linux-boot.js"
  );
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  await expect(requireQualifiedLinuxBoot(syntheticConsentHost)).rejects.toThrow();
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  await expect(requireQualifiedLinuxBoot(syntheticConsentHost)).resolves.toBeUndefined();
  boot = "bbbb2222-2222-4222-8222-222222222222";
  await expect(requireQualifiedLinuxBoot(syntheticConsentHost)).rejects.toThrow();
});
