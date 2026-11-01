import { createHash } from "node:crypto";

export type LegacyPackageKind = "PACKAGE_PURCHASE" | "PACKAGE_REDEMPTION";
export type LegacyRecoveryBinding = {
  version: 1;
  kind: LegacyPackageKind;
  packageId: string;
  requestHash: string;
};

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
};

export const legacyRecoveryBinding = (
  kind: LegacyPackageKind,
  packageId: string,
  input: unknown,
): LegacyRecoveryBinding => ({
  version: 1,
  kind,
  packageId,
  requestHash: createHash("sha256")
    .update(JSON.stringify(canonical(input)))
    .digest("hex"),
});
