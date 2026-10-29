import { expect, it } from "vitest";
import { parseQualifiedChronyTracking } from "../../src/modules/booking/trusted-time/host-clock.js";
import { syntheticConsentHost } from "../helpers/consent-host-fixture.js";

// Constructed from upstream 4.8 process_cmd_tracking field order, not captured host evidence.
const now = 1_914_912_060_000;
const profile = {
  ...syntheticConsentHost,
  chronycVersionOutput: "chronyc (chrony) version 4.8 (test-only)",
};
const fields = [
  "TEST",
  "192.0.2.1",
  "3",
  String(now / 1000),
  "0.001000000",
  "0.000000000",
  "0.000000000",
  "0.000",
  "0.000",
  "0.100",
  "0.004000000",
  "0.002000000",
  "64.0",
  "Normal",
];
it("reads the upstream 4.8 14-field layout without dropping the address column", () => {
  expect(parseQualifiedChronyTracking(fields.join(","), profile, now).bound.errorMs).toBe(6);
});
it("rejects missing/additional fields and unqualified 4.8 synchronization evidence", () => {
  for (const invalid of [
    fields.slice(1),
    [...fields, "extra"],
    fields.map((v, i) => (i === 13 ? "Not synchronised" : v)),
    fields.map((v, i) => (i === 0 ? "UNAPPROVED" : v)),
    fields.map((v, i) => (i === 3 ? String((now - 20_000) / 1000) : v)),
  ]) {
    expect(() => parseQualifiedChronyTracking(invalid.join(","), profile, now)).toThrow();
  }
});
