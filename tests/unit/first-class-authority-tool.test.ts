import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  adoptRelease,
  initSigningKey,
  readStatus,
  renewAttestation,
  resumeCheckout,
  revokeApprovalKey,
  stopCheckout,
} from "../../ops/first-class-authority/src/authority.js";
import { main, runCli } from "../../ops/first-class-authority/src/cli.js";
import { parseChronyTracking } from "../../ops/first-class-authority/src/host.js";
import { reserveSequence } from "../../ops/first-class-authority/src/state.js";
import {
  DEPLOYMENT_ATTESTATION_DOMAIN,
  publicKeyFingerprint,
} from "../../src/modules/booking/trusted-time/deployment-attestation.js";
import { parseQualifiedChronyTracking } from "../../src/modules/booking/trusted-time/host-clock.js";
import { computeArtifactSha256 } from "../../src/modules/booking/trusted-time/protected-authority-files.js";
import {
  BOOT,
  createToolFixture,
  GIT_SHA,
  MACHINE,
  NOW,
  SOURCE,
  tracking,
} from "../helpers/authority-tool-fixture.js";

let fixture: ReturnType<typeof createToolFixture> | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

/** Fresh synthetic host with a signing key and an adopted genesis release (sequence 1). */
async function adopted() {
  fixture = createToolFixture();
  const f = fixture;
  initSigningKey(f.env, false);
  const entry = await f.qualifiedEntry();
  const payload = f.record([entry]);
  const result = await adoptRelease(f.env, {
    record: payload,
    signature: f.signRecord(payload),
    sourceCheckout: SOURCE,
    genesis: true,
  });
  return { f, entry, payload, result };
}
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "OK",
    (error: Error) => error.message.split(":")[0],
  );

describe("deployment authority tool: issuance compatible with the published API verifier", () => {
  it("qualification measurement → Owner-signed record → adoption → API authority opens", async () => {
    const { f, result } = await adopted();
    expect(result).toMatchObject({ sequence: 1, restartApiRequired: true });
    const attestationBytes = f.published("attestation");
    // Canonical compact JSON, signed under the exact deployment-attestation domain.
    expect(JSON.stringify(JSON.parse(attestationBytes.toString("utf8")))).toBe(
      attestationBytes.toString("utf8"),
    );
    const deploymentKey = createPublicKey(f.published("deploymentPublicKeyPem"));
    expect(
      verify(
        null,
        Buffer.concat([Buffer.from(DEPLOYMENT_ATTESTATION_DOMAIN), attestationBytes]),
        deploymentKey,
        f.published("attestationSignature"),
      ),
    ).toBe(true);
    expect(publicKeyFingerprint(deploymentKey)).not.toBe(
      publicKeyFingerprint(f.approval.publicKey),
    );
    const a = f.publishedAttestation();
    expect(a.release).toEqual({
      gitSha: GIT_SHA,
      artifactSha256: computeArtifactSha256(f.paths.api),
      recordSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(a.host).toMatchObject({ hostId: MACHINE, bootId: BOOT });
    expect(a.trustedTime.latestMs - a.trustedTime.earliestMs).toBeLessThanOrEqual(2000);
    expect(a.expiresAtMs).toBe(a.trustedTime.earliestMs + 3_600_000);
    expect(a.registry.previousEntries).toEqual([]);
    // Evidence is retained under its attested digest.
    const evidence = readFileSync(
      join(f.paths.state, "evidence", `${a.trustedTime.evidenceSha256}.json`),
    );
    expect(evidence.length).toBeGreaterThan(0);
    // The API, reading only the published files, opens all gates.
    const api = f.startApi();
    expect(api.hostConfiguration).toBeDefined();
    expect(api.readLive()?.release).toMatchObject({ lifetimeMs: 1_800_000, hostId: MACHINE });
    // The private signing key never enters the API-readable directory.
    for (const name of readdirSync(f.paths.authority))
      expect(readFileSync(join(f.paths.authority, name), "utf8")).not.toContain("PRIVATE KEY");
    expect(
      readStatus(f.env, { bootId: BOOT, artifactSha256: a.release.artifactSha256 }),
    ).toMatchObject({
      verification: { valid: true, sequence: 1, recordMatchesAdopted: true },
    });
  });

  it("tool chrony parsing matches the API's qualified parser exactly", () => {
    const profile = {
      approvedBootId: BOOT,
      authorityId: "a",
      hostId: MACHINE,
      configurationHash: "a".repeat(64),
      chronycPath: "/usr/bin/chronyc",
      chronycSocketPath: "127.0.0.1",
      chronycVersionOutput: "v",
      referenceIds: ["TEST"],
      maxAcquireMs: 5000,
      maxSampleAgeMs: 10000,
      maxErrorMs: 1000,
      maxDriftPpm: 100,
      minRemainingMs: 1000,
    };
    const cases = [
      tracking(NOW),
      tracking(NOW, { 13: "Not synchronised" }),
      tracking(NOW, { 0: "LOCL" }),
      tracking(NOW, { 0: "7F7F0101" }),
      tracking(NOW, { 3: String((NOW - 60_000) / 1000) }),
      tracking(NOW, { 11: "2.0" }),
      tracking(NOW, { 9: "500" }),
      tracking(NOW, { 2: "0" }),
      `${tracking(NOW)},extra`,
      "garbage",
    ];
    for (const output of cases) {
      const outcome = (run: () => unknown) => {
        try {
          return run();
        } catch {
          return "REFUSED";
        }
      };
      const tool = outcome(() => parseChronyTracking(output, profile, NOW));
      const apiResult = outcome(() =>
        parseQualifiedChronyTracking(output, { ...profile, auditKey: Buffer.alloc(32) }, NOW),
      );
      expect(tool).toEqual(apiResult);
    }
  });
});

describe("deployment authority tool: renewal, sequence durability and partial writes", () => {
  it("renews monotonically across restarts, lost state and interrupted renewals", async () => {
    const { f } = await adopted();
    const api = f.startApi();
    expect(api.readLive()?.attestation.sequence).toBe(1);
    f.host.wall += 60_000;
    expect((await renewAttestation(f.env)).sequence).toBe(2);
    expect(api.readLive()?.attestation.sequence).toBe(2);
    // A "restarted" tool (fresh env object, same durable state) continues the sequence.
    expect((await renewAttestation({ ...f.env })).sequence).toBe(3);
    // Lost or rolled-back sequence state still never goes below the published attestation.
    unlinkSync(join(f.paths.state, "sequence.json"));
    expect((await renewAttestation(f.env)).sequence).toBe(4);
    // A crash after durable reservation skips the reserved number; nothing is reused.
    reserveSequence(f.paths.state, 0);
    writeFileSync(join(f.paths.authority, ".attestation.json.123.0123456789abcdef.tmp"), "partial");
    expect((await renewAttestation(f.env)).sequence).toBe(6);
    expect(readdirSync(f.paths.authority).some((n) => n.endsWith(".tmp"))).toBe(false);
    expect(api.readLive()?.attestation.sequence).toBe(6);
    // Interrupted publish (only one of the pair written) closes the gate; renewal repairs it.
    writeFileSync(join(f.paths.authority, "attestation.sig"), Buffer.alloc(64, 7));
    expect(api.readLive()).toBeUndefined();
    expect((await renewAttestation(f.env)).sequence).toBe(7);
    expect(api.readLive()?.attestation.sequence).toBe(7);
    // An interrupted operation's lock blocks mutation until an operator clears it.
    writeFileSync(join(f.paths.state, "operation.lock"), "999\n");
    expect(await code(renewAttestation(f.env))).toBe("OPERATION_LOCKED");
    unlinkSync(join(f.paths.state, "operation.lock"));
    expect(await code(renewAttestation(f.env))).toBe("OK");
  });

  it("caps expiry at the release validity and the API closes at expiry", async () => {
    fixture = createToolFixture();
    const f = fixture;
    initSigningKey(f.env, false);
    const payload = f.record([await f.qualifiedEntry()], { validUntilMs: NOW + 600_000 });
    await adoptRelease(f.env, {
      record: payload,
      signature: f.signRecord(payload),
      sourceCheckout: SOURCE,
      genesis: true,
    });
    expect(f.publishedAttestation().expiresAtMs).toBe(NOW + 600_000);
    const api = f.startApi();
    expect(api.readLive()).toBeDefined();
    f.host.wall = NOW + 600_000;
    expect(api.readLive()).toBeUndefined();
    // The record itself has expired: renewal refuses rather than extending it.
    expect(await code(renewAttestation(f.env))).toBe("RELEASE_NOT_APPROVED_FOR_HOST");
  });
});

describe("deployment authority tool: independent release, host and clock measurement", () => {
  it("refuses changed artifact, dependencies, host, boot or clock configuration", async () => {
    const { f } = await adopted();
    const before = f.published("attestation");
    const attempt = async (mutate: () => void, restore: () => void) => {
      mutate();
      const result = await code(renewAttestation(f.env));
      restore();
      return result;
    };
    const file = (path: string, content: string) => {
      const original = readFileSync(path);
      return [() => writeFileSync(path, content), () => writeFileSync(path, original)] as const;
    };
    expect(await attempt(...file(join(f.paths.api, "dist/app/server.js"), "evil\n"))).toBe(
      "ARTIFACT_CHANGED",
    );
    expect(await attempt(...file(join(f.paths.api, "node_modules/zod/index.js"), "evil\n"))).toBe(
      "ARTIFACT_CHANGED",
    );
    const host = f.host;
    const set = <K extends keyof typeof host>(key: K, value: (typeof host)[K]) => {
      const original = host[key];
      return [() => (host[key] = value), () => (host[key] = original)] as const;
    };
    expect(await attempt(...set("bootId", "cccc3333-3333-4333-8333-333333333333"))).toBe(
      "HOST_BOOT_NOT_QUALIFIED",
    );
    expect(await attempt(...set("machineId", "f".repeat(32)))).toBe("HOST_ID_MISMATCH");
    expect(await attempt(...set("kernel", "6.9.0-other"))).toBe("HOST_CONFIGURATION_MISMATCH");
    expect(await attempt(...set("confD", ["extra.conf"]))).toBe("CLOCK_CONFIGURATION_UNAVAILABLE");
    expect(
      await attempt(
        () => host.files.set("/etc/chrony/chrony.conf", "server rogue.example\n"),
        () => host.files.set("/etc/chrony/chrony.conf", "server time.example iburst nts\n"),
      ),
    ).toBe("HOST_CONFIGURATION_MISMATCH");
    expect(
      await attempt(
        () => host.files.delete("/usr/bin/chronyc"),
        () => host.files.set("/usr/bin/chronyc", "chronyc-binary"),
      ),
    ).toBe("CLOCK_SOURCE_NOT_INSTALLED");
    expect(await attempt(...set("timesyncd", "active"))).toBe("CLOCK_SOURCE_CONFLICT");
    expect(await attempt(...set("version", "chronyc (chrony) version 9.9"))).toBe(
      "HOST_CONFIGURATION_MISMATCH",
    );
    // Nothing was published by any refused renewal.
    expect(f.published("attestation").equals(before)).toBe(true);
  });

  it("refuses unavailable, unsynchronised, unapproved, stale, imprecise or stepped clocks", async () => {
    const { f } = await adopted();
    const host = f.host;
    const withTracking = async (over: Partial<Record<number, string>>) => {
      host.tracking = (wall) => tracking(wall, over);
      const result = await code(renewAttestation(f.env));
      host.tracking = (wall) => tracking(wall);
      return result;
    };
    expect(await withTracking({ 13: "Not synchronised" })).toBe("CLOCK_NOT_SYNCHRONISED");
    expect(await withTracking({ 0: "LOCL" })).toBe("CLOCK_NOT_SYNCHRONISED");
    expect(await withTracking({ 3: String((NOW - 60_000) / 1000) })).toBe("CLOCK_SAMPLE_STALE");
    expect(await withTracking({ 11: "2.0" })).toBe("CLOCK_ERROR_TOO_LARGE");
    host.chronycFails = true;
    // chronyc --version is also part of host measurement, so the clock source is unavailable.
    expect(await code(renewAttestation(f.env))).toBe("CLOCK_SOURCE_UNAVAILABLE");
    host.chronycFails = false;
    host.monoStepMs = 3000;
    expect(await code(renewAttestation(f.env))).toBe("CLOCK_ACQUISITION_FAILED");
    host.monoStepMs = 2;
    host.stepMs = 900;
    expect(await code(renewAttestation(f.env))).toBe("CLOCK_STEP_DETECTED");
    host.stepMs = 2;
    expect(await code(renewAttestation(f.env))).toBe("OK");
  });
});

describe("deployment authority tool: approvals, registry continuity and authorization", () => {
  it("refuses wrong, tampered or non-canonical approvals and unestablished releases", async () => {
    fixture = createToolFixture();
    const f = fixture;
    initSigningKey(f.env, false);
    const entry = await f.qualifiedEntry();
    const payload = f.record([entry]);
    const adopt = (record: Buffer, signature: Buffer, genesis = true) =>
      code(adoptRelease(f.env, { record, signature, sourceCheckout: SOURCE, genesis }));
    const rogue = generateKeyPairSync("ed25519").privateKey;
    expect(await adopt(payload, f.signRecord(payload, rogue))).toBe("RELEASE_RECORD_INVALID");
    const tampered = Buffer.from(payload);
    tampered.writeUInt8(tampered.readUInt8(20) ^ 1, 20);
    expect(await adopt(tampered, f.signRecord(payload))).toBe("RELEASE_RECORD_INVALID");
    const pretty = Buffer.from(JSON.stringify(JSON.parse(payload.toString()), null, 1));
    expect(await adopt(pretty, f.signRecord(pretty))).toBe("RELEASE_RECORD_INVALID");
    const otherPolicy = f.record([entry], {
      policy: { ...JSON.parse(payload.toString()).policy, maxErrorMs: 999 },
    });
    expect(await adopt(otherPolicy, f.signRecord(otherPolicy))).toBe("CLOCK_POLICY_MISMATCH");
    const expired = f.record([entry], { validFromMs: NOW - 2000, validUntilMs: NOW - 1000 });
    expect(await adopt(expired, f.signRecord(expired))).toBe("RELEASE_NOT_APPROVED_FOR_HOST");
    expect(await adopt(payload, f.signRecord(payload), false)).toBe("GENESIS_REQUIRED");
    f.host.gitHead = "e".repeat(40);
    expect(await adopt(payload, f.signRecord(payload))).toBe("RELEASE_SHA_MISMATCH");
    f.host.gitHead = GIT_SHA;
    f.host.gitStatus = " M src/app.ts\n";
    expect(await adopt(payload, f.signRecord(payload))).toBe("RELEASE_SOURCE_DIRTY");
    f.host.gitStatus = "";
    writeFileSync(join(f.paths.source, "dist/app/server.js"), "different build\n");
    expect(await adopt(payload, f.signRecord(payload))).toBe("ARTIFACT_MISMATCH");
    writeFileSync(join(f.paths.source, "dist/app/server.js"), "server\n");
    // Nothing was published by any refusal.
    expect(readdirSync(f.paths.authority)).toEqual([]);
    expect(await adopt(payload, f.signRecord(payload))).toBe("OK");
  });

  it("refuses to act without each provisioned authorization or signing key", async () => {
    fixture = createToolFixture();
    const f = fixture;
    const payload = f.record([await f.qualifiedEntry()]);
    const adopt = () =>
      code(
        adoptRelease(f.env, {
          record: payload,
          signature: f.signRecord(payload),
          sourceCheckout: SOURCE,
          genesis: true,
        }),
      );
    expect(await adopt()).toBe("SIGNING_KEY_MISSING");
    initSigningKey(f.env, false);
    expect(() => initSigningKey(f.env, false)).toThrow(/SIGNING_KEY_EXISTS/);
    for (const name of [
      "release-approval.pub",
      "clock-policy.json",
      "attestation-policy.json",
      "deployment.json",
    ]) {
      const original = readFileSync(join(f.paths.config, name));
      rmSync(join(f.paths.config, name));
      expect(await adopt()).toBe("AUTHORIZATION_MISSING");
      writeFileSync(join(f.paths.config, name), original);
    }
    f.writeConfig("attestation-policy.json", { version: 1, approvalReference: "x" });
    expect(await adopt()).toBe("CONFIGURATION_INVALID");
    f.writeConfig("clock-policy.json", { version: 1, approvalReference: "x", maxErrorMs: 1 });
    expect(await adopt()).toBe("CONFIGURATION_INVALID");
    expect(readdirSync(f.paths.authority)).toEqual([]);
  });

  it("keeps registry history continuous: successor, rollback, replay and genesis", async () => {
    const { f, entry, payload } = await adopted();
    const oldApi = f.startApi();
    const successorEntry = await f.qualifiedEntry("synthetic-host-b", { keyVersion: "v2" });
    const successor = f.record([{ ...entry, disposition: "VERIFY_ONLY" }, successorEntry]);
    const adopt = (record: Buffer, genesis = false) =>
      code(
        adoptRelease(f.env, {
          record,
          signature: f.signRecord(record),
          sourceCheckout: SOURCE,
          genesis,
        }),
      );
    expect(await adopt(successor)).toBe("OK");
    expect(f.publishedAttestation().registry.previousEntries).toEqual([entry]);
    // The running API pinned the previous release: closed until restart.
    expect(oldApi.readLive()).toBeUndefined();
    expect(f.startApi().readLive()?.release.authorityId).toBe("synthetic-host-b");
    // Dropping the historical entry (registry rollback) is refused.
    const rollback = f.record([successorEntry], { approvalReference: "rollback" });
    expect(await adopt(rollback)).toBe("RELEASE_NOT_APPROVED_FOR_HOST");
    // Re-promoting VERIFY_ONLY history to CURRENT is refused.
    const promote = f.record([entry, { ...successorEntry, disposition: "VERIFY_ONLY" }]);
    expect(await adopt(promote)).toBe("RELEASE_NOT_APPROVED_FOR_HOST");
    expect(await adopt(payload)).toBe("RELEASE_REPLAYED");
    expect(await adopt(f.record([successorEntry], { approvalReference: "g" }), true)).toBe(
      "GENESIS_REFUSED",
    );
    expect(f.startApi().readLive()?.release.authorityId).toBe("synthetic-host-b");
  });
});

describe("deployment authority tool: revocation, rotation and emergency stop", () => {
  it("stops immediately, stays stopped, and resumes only through a fresh renewal", async () => {
    const { f } = await adopted();
    const api = f.startApi();
    expect(api.readLive()).toBeDefined();
    stopCheckout(f.env, "incident", NOW);
    expect(existsSync(join(f.paths.authority, "attestation.json"))).toBe(false);
    expect(api.readLive()).toBeUndefined();
    expect(await code(renewAttestation(f.env))).toBe("CHECKOUT_STOPPED");
    const payload = f.record([await f.qualifiedEntry("synthetic-host-c", { keyVersion: "v3" })]);
    expect(
      await code(
        adoptRelease(f.env, {
          record: payload,
          signature: f.signRecord(payload),
          sourceCheckout: SOURCE,
          genesis: false,
        }),
      ),
    ).toBe("CHECKOUT_STOPPED");
    resumeCheckout(f.env);
    expect(api.readLive()).toBeUndefined();
    expect((await renewAttestation(f.env)).sequence).toBe(2);
    expect(api.readLive()?.attestation.sequence).toBe(2);
  });

  it("publishes approval-key revocations and stops on revoking the active anchor", async () => {
    const { f } = await adopted();
    const other = publicKeyFingerprint(generateKeyPairSync("ed25519").publicKey);
    expect(revokeApprovalKey(f.env, other, "synthetic-decision", NOW)).toMatchObject({
      stopped: false,
    });
    await renewAttestation(f.env);
    expect(f.publishedAttestation().trustAnchor.revokedApprovalKeySha256).toEqual([other]);
    expect(f.startApi().readLive()).toBeDefined();
    const active = publicKeyFingerprint(f.approval.publicKey);
    expect(revokeApprovalKey(f.env, active, "synthetic-decision", NOW)).toMatchObject({
      stopped: true,
    });
    expect(existsSync(join(f.paths.authority, "attestation.json"))).toBe(false);
    resumeCheckout(f.env);
    expect(await code(renewAttestation(f.env))).toBe("APPROVAL_KEY_REVOKED");
  });

  it("rotates the deployment signing key without restarting the API", async () => {
    const { f } = await adopted();
    const api = f.startApi();
    const before = f.published("deploymentPublicKeyPem");
    initSigningKey(f.env, true);
    await renewAttestation(f.env);
    expect(f.published("deploymentPublicKeyPem").equals(before)).toBe(false);
    expect(api.readLive()?.attestation.sequence).toBe(2);
    expect(readdirSync(join(f.paths.state, "retired-keys"))).toHaveLength(1);
  });
});

describe("deployment authority tool: shipped entry point", () => {
  it("refuses off Linux and without root, with no override", async () => {
    await expect(runCli(["status"])).rejects.toThrow(/UNSUPPORTED_PLATFORM|ROOT_REQUIRED/);
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      if (process.getuid?.() !== 0)
        await expect(runCli(["renew"])).rejects.toThrow(/ROOT_REQUIRED/);
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
    }
    const stderr: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await main(["renew"])).toBe(1);
    } finally {
      process.stderr.write = write;
    }
    expect(stderr.join("")).toMatch(/^(UNSUPPORTED_PLATFORM|ROOT_REQUIRED): /);
  });

  it("tool source has no environment override, embedded key or invented approval", () => {
    const dir = fileURLToPath(new URL("../../ops/first-class-authority/src", import.meta.url));
    for (const name of readdirSync(dir)) {
      const source = readFileSync(join(dir, name), "utf8");
      expect(source).not.toMatch(/process\.env|BEGIN [A-Z ]*PRIVATE KEY|synthetic/);
      expect(source).not.toMatch(/maxValidityMs:\s*\d|maxErrorMs:\s*\d/);
    }
    expect(readFileSync(join(dir, "contract.ts"), "utf8")).toContain(
      '"/etc/bookly-first-class-authority-tool"',
    );
  });
});
