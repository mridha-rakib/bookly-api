/** Phase 4.1 — release-to-release registry history continuity (P4I §3 step 1, §4).
 * All entries are SYNTHETIC test data; no key is resolved by the check. */
import { describe, expect, it } from "vitest";
import { assertConsentHostHistoryContinuity } from "../../src/modules/booking/trusted-time/host-authority-history.js";
import type { ConsentHostAuthorityEntry } from "../../src/modules/booking/trusted-time/host-authority-registry.js";
import { syntheticConsentHost } from "../helpers/consent-host-fixture.js";

const { auditKey: _key, ...base } = syntheticConsentHost;
let boot = 0;
const generation = (
  authorityId: string,
  disposition: ConsentHostAuthorityEntry["disposition"],
  keyVersion = `test-${authorityId}`,
): ConsentHostAuthorityEntry => ({
  version: 1,
  qualificationReference: `test-review-${authorityId}`,
  chronycSha256: "a".repeat(64),
  chronydSha256: "b".repeat(64),
  profile: {
    ...base,
    referenceIds: [...base.referenceIds],
    authorityId,
    approvedBootId: `aaaa1111-1111-4111-8111-${String(++boot).padStart(12, "0")}`,
  },
  disposition,
  keyReference: "test-protected-key",
  keyVersion,
});
const copy = (
  entry: ConsentHostAuthorityEntry,
  patch: Partial<ConsentHostAuthorityEntry> = {},
) => ({
  ...structuredClone(entry),
  ...patch,
});
const ok = (previous: ConsentHostAuthorityEntry[], next: ConsentHostAuthorityEntry[]) =>
  expect(() => assertConsentHostHistoryContinuity(previous, next)).not.toThrow();
const refused = (previous: ConsentHostAuthorityEntry[], next: ConsentHostAuthorityEntry[]) =>
  expect(() => assertConsentHostHistoryContinuity(previous, next)).toThrow(
    /^Consent host authority history is not continuous$/,
  );

describe("consent host authority history continuity", () => {
  it("allows a first release, unchanged history, rotation and revocation", () => {
    const g1 = generation("g1", "CURRENT");
    ok([], [g1]);
    ok([g1], [copy(g1)]);
    const g2 = generation("g2", "CURRENT");
    ok([g1], [copy(g1, { disposition: "VERIFY_ONLY" }), g2]);
    ok(
      [copy(g1, { disposition: "VERIFY_ONLY" }), g2],
      [copy(g1, { disposition: "REVOKED" }), copy(g2)],
    );
    ok([g1], [copy(g1, { disposition: "REVOKED" })]);
  });

  it("refuses removal of any released generation, including revoked ones", () => {
    const g1 = generation("g1", "VERIFY_ONLY");
    const g2 = generation("g2", "CURRENT");
    refused([g1, g2], [g2]);
    const r = generation("r", "REVOKED");
    refused([r, g2], [g2]);
  });

  it("refuses any change to a released generation other than an allowed disposition move", () => {
    const g1 = generation("g1", "CURRENT");
    for (const patch of [
      { keyVersion: "test-other" },
      { keyReference: "test-other-key" },
      { qualificationReference: "test-rewritten" },
      { chronycSha256: "c".repeat(64) },
      { profile: { ...g1.profile, maxErrorMs: g1.profile.maxErrorMs + 1 } },
      { profile: { ...g1.profile, approvedBootId: "bbbb1111-1111-4111-8111-111111111111" } },
    ])
      refused([g1], [copy(g1, patch)]);
  });

  it("revocation is terminal and earlier generations are never promoted back to issuer", () => {
    const r = generation("r", "REVOKED");
    refused([r], [copy(r, { disposition: "VERIFY_ONLY" })]);
    refused([r], [copy(r, { disposition: "CURRENT" })]);
    const v = generation("v", "VERIFY_ONLY");
    refused([v], [copy(v, { disposition: "CURRENT" })]);
  });

  it("a new id cannot reintroduce a revoked key version or a revoked profile", () => {
    const r = generation("r", "REVOKED", "test-compromised");
    refused([r], [copy(r), generation("fresh", "CURRENT", "test-compromised")]);
    const sameProfile = copy(r, {
      disposition: "CURRENT",
      keyVersion: "test-new",
      profile: { ...r.profile, authorityId: "fresh" },
    });
    refused([r], [copy(r), sameProfile]);
    // Revoked in this same release, then re-added under a fresh id: still refused.
    const g = generation("g", "CURRENT", "test-g");
    refused([g], [copy(g, { disposition: "REVOKED" }), generation("again", "CURRENT", "test-g")]);
  });

  it("both snapshots must be structurally valid registries", () => {
    const g1 = generation("g1", "CURRENT");
    const padded = copy(g1, { profile: { ...g1.profile, authorityId: " g1" } });
    refused([], [padded]);
    refused([padded], [g1]);
    refused([], [g1, generation("g2", "CURRENT")]);
  });
});
