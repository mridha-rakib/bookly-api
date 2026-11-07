import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DevelopmentClock } from "../../dev/main-purchase/clock.js";
import { requireDevelopmentContract } from "../../dev/main-purchase/configuration.js";
import { CONTRACT, fingerprint, validateEnvironment } from "../../dev/main-purchase/guards.js";
import { verifyPackageBatchActivation } from "../../src/modules/booking/package-batch-authority.js";
import { assessConsentCommitDeadline } from "../../src/modules/booking/package-consent-commit-deadline.js";
import { shippedPackageConsentHttpActivation } from "../../src/modules/booking/package-consent-http-activation.js";
import { verifyConsentHostObservation } from "../../src/modules/booking/trusted-time/host-clock.js";

const environment = () => ({
  NODE_ENV: "development",
  BOOKLY_MAIN_PURCHASE_CONTRACT: CONTRACT,
  HTTP_BIND_HOST: "127.0.0.1",
  PORT: "3001",
  CORS_ORIGINS: "http://localhost:3000",
  FRONTEND_BASE_URL: "http://localhost:3000",
  MONGODB_URI: "mongodb://example.invalid/existing-development",
  STRIPE_SECRET_KEY: "sk_test_unit_only",
  STRIPE_PUBLISHABLE_KEY: "pk_test_unit_only",
  STRIPE_WEBHOOK_SECRET: "whsec_unit_only",
  PACKAGE_CONSENT_QUOTE_LIFETIME_MS: "1800000",
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bookly-main-clock-")),
    e = environment();
  const installation = {
    contract: CONTRACT as typeof CONTRACT,
    installationId: randomUUID(),
    developmentDataApproved: true as const,
    databaseFingerprint: fingerprint(e.MONGODB_URI),
    stripeSecretFingerprint: fingerprint(e.STRIPE_SECRET_KEY),
    stripePublishableFingerprint: fingerprint(e.STRIPE_PUBLISHABLE_KEY),
  };
  writeFileSync(join(dir, "installation.json"), JSON.stringify(installation));
  writeFileSync(join(dir, "signing.key"), randomBytes(32).toString("hex"));
  let wall = 2_000_000_000_000,
    mono = 1000;
  const open = () =>
    new DevelopmentClock(
      dir,
      e,
      () => wall,
      () => mono,
    );
  return {
    dir,
    e,
    installation,
    open,
    advance: (ms: number) => {
      wall += ms;
      mono += ms;
    },
    step: (ms: number) => {
      wall += ms;
    },
  };
}
describe("main development environment boundary", () => {
  it("defaults the contract only for the dedicated development composition and keeps shipped startup separate", () => {
    const devEnvironment: Record<string, string | undefined> = { NODE_ENV: "development" };
    requireDevelopmentContract(devEnvironment);
    expect(devEnvironment["BOOKLY_MAIN_PURCHASE_CONTRACT"]).toBe(CONTRACT);

    const productionEnvironment: Record<string, string | undefined> = { NODE_ENV: "production" };
    expect(() => requireDevelopmentContract(productionEnvironment)).toThrow(
      "Main purchase authority is development-only",
    );
    expect(productionEnvironment["BOOKLY_MAIN_PURCHASE_CONTRACT"]).toBeUndefined();
    expect(() =>
      requireDevelopmentContract({
        NODE_ENV: "development",
        BOOKLY_MAIN_PURCHASE_CONTRACT: "disabled",
      }),
    ).toThrow(`Invalid BOOKLY_MAIN_PURCHASE_CONTRACT; expected ${CONTRACT}`);

    const scripts = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
      .scripts as Record<string, string>;
    expect(scripts["dev"]).toBe("pnpm run dev:purchase");
    expect(scripts["dev:purchase"]).toContain("node --watch --import tsx");
    expect(scripts["dev:purchase"]).toContain("dev/main-purchase/server.ts");
    expect(scripts["start"]).toBe("node dist/app/server.js");
  });

  it("pins the exact existing database and TEST keys while allowing configured loopback ports", () => {
    const f = fixture();
    expect(() => validateEnvironment(f.e, f.installation)).not.toThrow();
    expect(() =>
      validateEnvironment(
        {
          ...f.e,
          PORT: "4001",
          FRONTEND_BASE_URL: "http://localhost:4000",
          CORS_ORIGINS: "http://localhost:4000",
          PUBLIC_API_BASE_URL: "http://localhost:4001/api/v1",
        },
        f.installation,
      ),
    ).not.toThrow();
    for (const patch of [
      { NODE_ENV: "production" },
      { NODE_ENV: "test" },
      { BOOKLY_MAIN_PURCHASE_CONTRACT: "" },
      { HTTP_BIND_HOST: "0.0.0.0" },
      { CORS_ORIGINS: "https://example.com" },
      { FRONTEND_BASE_URL: "http://example.com" },
      { FRONTEND_BASE_URL: "http://localhost:3000/other" },
      { PUBLIC_API_BASE_URL: "http://localhost:9999/api/v1" },
      { MONGODB_URI: "mongodb://example.invalid/different" },
      { STRIPE_SECRET_KEY: "sk_live_no" },
      { STRIPE_SECRET_KEY: "sk_test_different" },
      { STRIPE_PUBLISHABLE_KEY: "pk_live_no" },
      { STRIPE_WEBHOOK_SECRET: "" },
      { PACKAGE_CONSENT_QUOTE_LIFETIME_MS: "1800001" },
      { BOOKLY_LOCAL_ACCEPTANCE_AUTHORITY_DIR: "anything" },
    ])
      expect(() => validateEnvironment({ ...f.e, ...patch }, f.installation)).toThrow();
  });
});
describe("development host-relative consent evidence", () => {
  it("seals exact witnesses, rejects tampering, and remains rejected by shipped production", async () => {
    const f = fixture(),
      clock = f.open(),
      witness = "a".repeat(64);
    try {
      const observation = clock.observe(witness);
      expect(clock.verify(observation, witness)).toEqual(observation);
      expect(observation.versionOutput).toContain("NO-QUALIFIED-UTC");
      expect(() =>
        clock.verify({ ...observation, latestMs: observation.latestMs + 1 }, witness),
      ).toThrow();
      expect(() => clock.verify(observation, "b".repeat(64))).toThrow();
      expect(() => verifyConsentHostObservation(observation, witness)).toThrow();
      await expect(verifyPackageBatchActivation()).rejects.toMatchObject({
        code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE",
      });
      expect(shippedPackageConsentHttpActivation).toEqual({});
    } finally {
      clock.close();
    }
  });
  it.each(["backward", "forward", "gap"])(
    "latches %s clock discontinuity without re-anchoring",
    (kind) => {
      const f = fixture(),
        clock = f.open();
      try {
        clock.observe("a".repeat(64));
        if (kind === "backward") f.step(-1);
        if (kind === "forward") f.step(51);
        if (kind === "gap") f.advance(5001);
        expect(() => clock.check()).toThrow();
        if (kind === "backward") f.step(1);
        if (kind === "forward") f.step(-51);
        expect(() => clock.observe("a".repeat(64))).toThrow();
      } finally {
        clock.close();
      }
    },
  );
  it("never enlarges the deadline for tolerated coordinate disagreement, equality or lateness", () => {
    const f = fixture(),
      clock = f.open();
    try {
      const issue = clock.observe("a".repeat(64));
      f.advance(100);
      f.step(20);
      const commit = clock.observe("b".repeat(64));
      const input = {
        retainedIssuedAtMs: issue.earliestMs,
        retainedExpiresAtMs: issue.earliestMs + 1800000,
        issuanceAttestation: issue,
        postCommitObservation: commit,
      };
      expect(assessConsentCommitDeadline(input, [CONTRACT])).toMatchObject({ kind: "CERTIFIED" });
      for (const extra of [0, 1])
        expect(
          assessConsentCommitDeadline(
            {
              ...input,
              postCommitObservation: { ...commit, latestMs: input.retainedExpiresAtMs + extra },
            },
            [CONTRACT],
          ),
        ).toMatchObject({ kind: "UNRESOLVED" });
      expect(commit.latestMs).toBeGreaterThanOrEqual(JSON.parse(commit.tracking).wallMs);
    } finally {
      clock.close();
    }
  });
  it("retains historical samples and changes epoch on restart, without fabricating an old witness", () => {
    const f = fixture(),
      first = f.open(),
      witness = "a".repeat(64);
    const observation = first.observe(witness);
    first.close();
    f.advance(1000);
    const second = f.open();
    try {
      expect(second.verify(observation, witness)).toEqual(observation);
      expect(second.observe(witness).bootId).not.toBe(observation.bootId);
      expect(() => second.verify({ ...observation, bootId: randomUUID() }, witness)).toThrow();
      expect(() => f.open()).toThrow(/already running/);
    } finally {
      second.close();
    }
  });
  it("refuses backward restart and missing, altered or truncated retained history", () => {
    const f = fixture(),
      first = f.open();
    first.observe("a".repeat(64));
    first.close();
    f.step(-1);
    expect(() => f.open()).toThrow(/backward/);
    f.step(1);
    const original = readFileSync(join(f.dir, "clock.journal"), "utf8");
    writeFileSync(
      join(f.dir, "clock.journal"),
      original.replace('"kind":"SAMPLE"', '"kind":"EPOCH"'),
    );
    expect(() => f.open()).toThrow(/integrity/);
    writeFileSync(join(f.dir, "clock.journal"), original);
    appendFileSync(join(f.dir, "clock.journal"), "truncated");
    expect(() => f.open()).toThrow(/Incomplete/);
  });
  it("denies admission when the effective database/provider environment changes", () => {
    const f = fixture(),
      clock = f.open();
    try {
      f.e.STRIPE_SECRET_KEY = "sk_live_no";
      expect(() => clock.check()).toThrow();
    } finally {
      clock.close();
    }
  });
});
