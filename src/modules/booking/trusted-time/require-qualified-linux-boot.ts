import { readFile } from "node:fs/promises";
import { validateConsentHostBoot } from "./host-policy.js";
import type { QualifiedConsentHost } from "./qualified-host.js";

/** The target is the currently running, explicitly qualified Linux boot. */
export async function requireQualifiedLinuxBoot(host: QualifiedConsentHost): Promise<void> {
  if (process.platform !== "linux") throw new Error("Qualified Linux host unavailable");
  const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  validateConsentHostBoot(host, boot, boot);
}
