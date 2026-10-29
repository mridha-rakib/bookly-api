import { afterEach, expect, it, vi } from "vitest";
import {
  type ConsentHostAuthorityEntry,
  createConsentHostAuthorityRegistry,
} from "../../src/modules/booking/trusted-time/host-authority-registry.js";
import { verifyConsentHostObservation } from "../../src/modules/booking/trusted-time/host-clock.js";
import {
  requireConsentHostVerificationProfile,
  requireQualifiedConsentHost,
} from "../../src/modules/booking/trusted-time/qualified-host.js";
import { syntheticConsentHost, syntheticHostObservation } from "../helpers/consent-host-fixture.js";

vi.mock("../../src/modules/booking/trusted-time/qualified-host.js", () => ({
  requireQualifiedConsentHost: vi.fn(),
  requireConsentHostVerificationProfile: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

const entry = (
  disposition: ConsentHostAuthorityEntry["disposition"] = "VERIFY_ONLY",
): ConsentHostAuthorityEntry => {
  const { auditKey: _key, ...profile } = syntheticConsentHost;
  return {
    version: 1,
    qualificationReference: "test-only-review",
    chronycSha256: "a".repeat(64),
    chronydSha256: "b".repeat(64),
    profile,
    disposition,
    keyReference: "test-protected-key",
    keyVersion: "test-v1",
  };
};
const identity = () => ({
  authorityId: syntheticConsentHost.authorityId,
  hostId: syntheticConsentHost.hostId,
  configurationHash: syntheticConsentHost.configurationHash,
  approvedBootId: syntheticConsentHost.approvedBootId,
});

it("keeps old sealed evidence verifiable after selecting a different current boot/key", () => {
  const old = entry(),
    next = entry("CURRENT");
  next.profile = {
    ...next.profile,
    authorityId: "synthetic-next-generation",
    approvedBootId: "bbbb1111-1111-4111-8111-111111111111",
  };
  next.keyVersion = "test-v2";
  const resolver = vi.fn((_reference: string, version: string) =>
    version === "test-v1" ? syntheticConsentHost.auditKey : Buffer.alloc(32, 23),
  );
  const registry = createConsentHostAuthorityRegistry([old, next], resolver);
  vi.mocked(requireQualifiedConsentHost).mockImplementation(() => registry.requireCurrent());
  vi.mocked(requireConsentHostVerificationProfile).mockImplementation((id) =>
    registry.requireVerification(id),
  );
  const witness = "b".repeat(64),
    sample = syntheticHostObservation(witness);
  expect(registry.requireCurrent().approvedBootId).toBe(next.profile.approvedBootId);
  expect(verifyConsentHostObservation(sample, witness)).toEqual(sample);
  expect(requireQualifiedConsentHost).not.toHaveBeenCalled();
  expect(resolver).toHaveBeenCalledWith("test-protected-key", "test-v1", "VERIFY");
  expect(resolver).toHaveBeenCalledWith("test-protected-key", "test-v2", "SIGN");
});

it("supports historical verification with no currently qualified issuer", () => {
  const registry = createConsentHostAuthorityRegistry(
    [entry()],
    () => syntheticConsentHost.auditKey,
  );
  expect(() => registry.requireCurrent()).toThrow("unavailable");
  expect(registry.requireVerification(identity()).authorityId).toBe(identity().authorityId);
});

it("rejects missing, revoked and substituted identities before resolving any key", () => {
  const resolve = vi.fn(() => syntheticConsentHost.auditKey);
  const registry = createConsentHostAuthorityRegistry([entry("REVOKED")], resolve);
  expect(() => registry.requireVerification(identity())).toThrow("unavailable");
  const allowed = createConsentHostAuthorityRegistry([entry()], resolve);
  for (const patch of [
    { authorityId: "unknown" },
    { hostId: "other" },
    { approvedBootId: "bbbb1111-1111-4111-8111-111111111111" },
    { configurationHash: "f".repeat(64) },
  ]) {
    expect(() => allowed.requireVerification({ ...identity(), ...patch })).toThrow("unavailable");
  }
  expect(resolve).not.toHaveBeenCalled();
});

it("rejects duplicate generations, multiple issuers and malformed profiles", () => {
  const resolve = () => syntheticConsentHost.auditKey;
  expect(() => createConsentHostAuthorityRegistry([entry(), entry()], resolve)).toThrow();
  const second = entry("CURRENT");
  second.profile = { ...second.profile, authorityId: "second" };
  expect(() => createConsentHostAuthorityRegistry([entry("CURRENT"), second], resolve)).toThrow();
  expect(() =>
    createConsentHostAuthorityRegistry([{ ...entry(), keyVersion: "" }], resolve),
  ).toThrow();
  expect(() =>
    createConsentHostAuthorityRegistry([{ ...entry(), chronycSha256: "unknown" }], resolve),
  ).toThrow();
});

it("copies reviewed entries and returned buffers instead of exposing mutable registry state", () => {
  const input = entry("CURRENT"),
    originalKey = Buffer.from(syntheticConsentHost.auditKey);
  const registry = createConsentHostAuthorityRegistry([input], () => originalKey);
  input.profile.hostId = "modified";
  input.disposition = "REVOKED";
  const returned = registry.requireCurrent();
  returned.auditKey.fill(0);
  returned.hostId = "modified";
  expect(registry.requireCurrent().hostId).toBe(syntheticConsentHost.hostId);
  expect(registry.requireCurrent().auditKey).toEqual(syntheticConsentHost.auditKey);
});

it("re-resolves protected key availability and sanitizes resolver failures", () => {
  const resolve = vi
    .fn()
    .mockReturnValueOnce(syntheticConsentHost.auditKey)
    .mockImplementation(() => {
      throw Error("DO-NOT-EXPOSE-SECRET-REFERENCE");
    });
  const registry = createConsentHostAuthorityRegistry([entry("CURRENT")], resolve);
  registry.requireCurrent();
  expect(() => registry.requireCurrent()).toThrow(/^Consent host authority unavailable$/);
  expect(() => registry.requireVerification(identity())).toThrow(
    /^Consent host authority unavailable$/,
  );
});
