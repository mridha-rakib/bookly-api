import { afterEach, expect, it, vi } from "vitest";
import {
  parseQualifiedChronyTracking,
  verifyConsentHostObservation,
} from "../../src/modules/booking/trusted-time/host-clock.js";
import { syntheticConsentHost, syntheticHostObservation } from "../helpers/consent-host-fixture.js";

vi.mock("../../src/modules/booking/trusted-time/qualified-host.js", () => ({
  requireQualifiedConsentHost: () => syntheticConsentHost,
  requireConsentHostVerificationProfile: () => syntheticConsentHost,
}));
afterEach(() => vi.restoreAllMocks());
it("sealed host bounds bind the exact witness and reject alteration", () => {
  const witness = "b".repeat(64),
    sample = syntheticHostObservation(witness);
  expect(verifyConsentHostObservation(sample, witness)).toEqual(sample);
  expect(() =>
    verifyConsentHostObservation({ ...sample, latestMs: sample.latestMs - 1 }, witness),
  ).toThrow();
  expect(() => verifyConsentHostObservation(sample, "c".repeat(64))).toThrow();
});
it("fresh-looking bounds from a foreign configuration or excessive uncertainty are rejected", () => {
  const witness = "b".repeat(64);
  expect(() =>
    verifyConsentHostObservation(
      syntheticHostObservation(witness, { configurationHash: "d".repeat(64) }),
      witness,
    ),
  ).toThrow();
  expect(() =>
    verifyConsentHostObservation(
      syntheticHostObservation(witness, { earliestMs: Date.now() - 100000 }),
      witness,
    ),
  ).toThrow();
  expect(() =>
    verifyConsentHostObservation(
      syntheticHostObservation(witness, { bootId: "bbbb1111-1111-4111-8111-111111111111" }),
      witness,
    ),
  ).toThrow();
});
it("tracking CSV includes the separate address field and uses the documented error components", () => {
  const now = Date.parse("2030-08-19T08:01:00Z");
  const fields = [
    "TEST",
    "192.0.2.1",
    "3",
    String(now / 1000),
    "0.001",
    "0",
    "0",
    "0",
    "0",
    "0.1",
    "0.004",
    "0.002",
    "64",
    "Normal",
  ];
  const result = parseQualifiedChronyTracking(fields.join(","), syntheticConsentHost, now);
  expect(result.referenceTimeMs).toBe(now);
  expect(result.bound.errorMs).toBe(6); // ceil(1ms + 2ms + half of 4ms) + read granularity
  for (const [index, value] of [
    [13, "Not synchronised"],
    [3, String((now - 20000) / 1000)],
    [9, "1000"],
    [10, "-1"],
    [4, ""],
  ] as const) {
    const invalid = [...fields];
    invalid[index] = value;
    expect(() =>
      parseQualifiedChronyTracking(invalid.join(","), syntheticConsentHost, now),
    ).toThrow();
  }
  expect(() =>
    parseQualifiedChronyTracking(
      fields.filter((_, i) => i !== 1).join(","),
      syntheticConsentHost,
      now,
    ),
  ).toThrow();
});
