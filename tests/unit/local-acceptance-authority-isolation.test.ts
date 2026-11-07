/** BC-F05C: the NON-PRODUCTION local acceptance authority (api/dev/local-acceptance) stays a
 * separate trust domain. Shipped modules are imported WITHOUT mocks: production must keep
 * denying, and evidence sealed by the local authority must never verify in production. */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertLocalAcceptanceComposed,
  LOCAL_AUTHORITY_ID,
  loadLocalAuthority,
  observeLocalAcceptanceClock,
} from "../../dev/local-acceptance/authority.js";
import {
  assertLocalAcceptanceEnvironment,
  assertLoopbackMongoUri,
  LocalAcceptanceRefusal,
} from "../../dev/local-acceptance/guards.js";
import { verifyPackageBatchActivation } from "../../src/modules/booking/package-batch-authority.js";
import { readPackageCheckoutAvailability } from "../../src/modules/booking/package-checkout-availability.js";
import {
  readPackageConsentHttpReadiness,
  shippedPackageConsentHttpActivation,
} from "../../src/modules/booking/package-consent-http-activation.js";
import { verifyConsentHostObservation } from "../../src/modules/booking/trusted-time/host-clock.js";
import { validateConsentHostPolicy } from "../../src/modules/booking/trusted-time/host-policy.js";
import { requireQualifiedConsentHost } from "../../src/modules/booking/trusted-time/qualified-host.js";

const apiRoot = resolve(__dirname, "..", "..");
const authorityDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "bcf05c-authority-"));
  writeFileSync(
    join(dir, "identity.json"),
    JSON.stringify({
      label: LOCAL_AUTHORITY_ID,
      installationId: randomBytes(16).toString("hex"),
      bootId: randomUUID(),
      createdAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, "authority.key"), randomBytes(32).toString("hex"));
  return dir;
};
const goodEnv = (): Record<string, string | undefined> => ({
  NODE_ENV: "development",
  DOTENV_CONFIG_PATH: resolve(apiRoot, "..", "local-acceptance", "api.local.env"),
  MONGODB_URI: "mongodb://127.0.0.1:27117/bookly_local_acceptance?replicaSet=bookly-local",
  HTTP_BIND_HOST: "127.0.0.1",
  CORS_ORIGINS: "http://127.0.0.1:3101,http://localhost:3101",
  FRONTEND_BASE_URL: "http://127.0.0.1:3101",
  PUBLIC_API_BASE_URL: "http://127.0.0.1:3100/api/v1",
  BOOKLY_LOCAL_ACCEPTANCE_AUTHORITY_DIR: "/somewhere",
});

describe("shipped production composition stays fail-closed", () => {
  it("denies the consent host, Batch admission, Consent HTTP and catalogue checkout", async () => {
    expect(() => requireQualifiedConsentHost()).toThrow(/qualification/i);
    await expect(verifyPackageBatchActivation()).rejects.toMatchObject({
      code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE",
      statusCode: 503,
    });
    expect(shippedPackageConsentHttpActivation).toEqual({});
    expect(readPackageConsentHttpReadiness(shippedPackageConsentHttpActivation)).toEqual({
      state: "DISABLED",
    });
    await expect(readPackageCheckoutAvailability()).resolves.toBe(false);
  });

  it("rejects evidence sealed by the local acceptance authority", () => {
    const host = loadLocalAuthority(authorityDir());
    const witness = "a".repeat(64);
    const local = observeLocalAcceptanceClock(host, witness);
    expect(local.authorityId).toBe("bookly-local-acceptance-NONPRODUCTION");
    expect(() => verifyConsentHostObservation(local, witness)).toThrow(
      /verification authority is unavailable/i,
    );
  });
});

describe("local acceptance authority identity", () => {
  it("is structurally valid, labelled non-production and seals with its own key", () => {
    const host = loadLocalAuthority(authorityDir());
    expect(() => validateConsentHostPolicy(host)).not.toThrow();
    expect(host.authorityId).toBe(LOCAL_AUTHORITY_ID);
    expect(host.chronycVersionOutput).toMatch(/NONPRODUCTION/);
    expect(host.maxErrorMs).toBe(1000);
    const other = loadLocalAuthority(authorityDir());
    expect(other.hostId).not.toBe(host.hostId);
    const a = observeLocalAcceptanceClock(host, "b".repeat(64));
    const b = observeLocalAcceptanceClock(other, "b".repeat(64));
    expect(a.seal).not.toBe(b.seal);
    expect(a.latestMs - a.earliestMs).toBe(2000);
  });

  it("refuses a missing or mislabelled authority and any un-composed use", () => {
    expect(() => loadLocalAuthority(join(tmpdir(), `missing-${randomUUID()}`))).toThrow(
      LocalAcceptanceRefusal,
    );
    const dir = authorityDir();
    const identity = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8"));
    writeFileSync(join(dir, "identity.json"), JSON.stringify({ ...identity, label: "production" }));
    expect(() => loadLocalAuthority(dir)).toThrow(/invalid/);
    expect(() => assertLocalAcceptanceComposed()).toThrow(/did not compose/);
  });
});

describe("local acceptance override (composed)", () => {
  it("verifies only the exact local identity and delegates every other identity to the shipped denial", async () => {
    const { markLocalAcceptanceComposed } = await import("../../dev/local-acceptance/authority.js");
    const host = loadLocalAuthority(authorityDir());
    markLocalAcceptanceComposed(host);
    try {
      const override = await import("../../dev/local-acceptance/overrides/qualified-host.js");
      expect(override.requireQualifiedConsentHost()).toBe(host);
      const exact = {
        authorityId: host.authorityId,
        hostId: host.hostId,
        configurationHash: host.configurationHash,
        approvedBootId: host.approvedBootId,
      };
      expect(override.requireConsentHostVerificationProfile(exact)).toBe(host);
      for (const patch of [
        { authorityId: "synthetic-host" },
        { hostId: "test-only" },
        { configurationHash: "a".repeat(64) },
        { approvedBootId: randomUUID() },
      ])
        expect(() =>
          override.requireConsentHostVerificationProfile({ ...exact, ...patch }),
        ).toThrow(/verification authority is unavailable/i);
      const batch = await import("../../dev/local-acceptance/overrides/package-batch-authority.js");
      await expect(batch.verifyPackageBatchActivation()).resolves.toBeUndefined();
    } finally {
      delete (globalThis as Record<symbol, unknown>)[Symbol.for("bookly.localAcceptance.composed")];
    }
    const batch = await import("../../dev/local-acceptance/overrides/package-batch-authority.js");
    await expect(batch.verifyPackageBatchActivation()).rejects.toThrow(/did not compose/);
  });
});

describe("local acceptance startup guards", () => {
  it("accepts only the explicit loopback local acceptance composition", () => {
    expect(() => assertLocalAcceptanceEnvironment(goodEnv(), { apiRoot })).not.toThrow();
  });

  it.each([
    ["production mode", { NODE_ENV: "production" }],
    ["test mode", { NODE_ENV: "test" }],
    ["operational api/.env", { DOTENV_CONFIG_PATH: join(apiRoot, ".env") }],
    ["no explicit env file", { DOTENV_CONFIG_PATH: undefined }],
    [
      "SRV database",
      { MONGODB_URI: "mongodb+srv://u:p@cluster0.example.net/bookly_local_acceptance" },
    ],
    ["remote host", { MONGODB_URI: "mongodb://10.0.0.5:27017/bookly_local_acceptance" }],
    [
      "mixed hosts",
      { MONGODB_URI: "mongodb://127.0.0.1:27117,db.example.net:27017/bookly_local_acceptance" },
    ],
    [
      "credentials in URI",
      { MONGODB_URI: "mongodb://u:p@127.0.0.1:27117/bookly_local_acceptance" },
    ],
    ["other database", { MONGODB_URI: "mongodb://127.0.0.1:27117/bookly?replicaSet=bookly-local" }],
    ["public bind", { HTTP_BIND_HOST: "0.0.0.0" }],
    ["remote CORS", { CORS_ORIGINS: "https://bookly.cy" }],
    ["remote frontend", { FRONTEND_BASE_URL: "https://bookly.cy" }],
    ["live secret", { STRIPE_SECRET_KEY: "sk_live_abc" }],
    ["live restricted key anywhere", { SOME_KEY: "rk_live_abc" }],
    ["non-test publishable", { STRIPE_PUBLISHABLE_KEY: "pk_live_abc" }],
    ["altered consent lifetime", { PACKAGE_CONSENT_QUOTE_LIFETIME_MS: "3600000" }],
    ["no authority dir", { BOOKLY_LOCAL_ACCEPTANCE_AUTHORITY_DIR: undefined }],
  ])("refuses %s", (_name, patch) => {
    expect(() => assertLocalAcceptanceEnvironment({ ...goodEnv(), ...patch }, { apiRoot })).toThrow(
      LocalAcceptanceRefusal,
    );
  });

  it("parses only loopback mongodb URIs for the designated database", () => {
    expect(assertLoopbackMongoUri("mongodb://localhost:27117/bookly_local_acceptance")).toBe(
      "bookly_local_acceptance",
    );
    expect(() => assertLoopbackMongoUri(undefined)).toThrow(LocalAcceptanceRefusal);
  });
});

describe("build boundary", () => {
  it("keeps dev/local-acceptance out of the compiled production artifact", () => {
    const tsconfig = JSON.parse(readFileSync(join(apiRoot, "tsconfig.json"), "utf8"));
    expect(tsconfig.include).toEqual(["src/**/*.ts"]);
    expect(tsconfig.compilerOptions.rootDir).toBe("src");
    const dockerfile = readFileSync(join(apiRoot, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/COPY src \.\/src/);
    expect(dockerfile).not.toMatch(/COPY dev/);
    const scripts = JSON.parse(readFileSync(join(apiRoot, "package.json"), "utf8"))
      .scripts as Record<string, string>;
    expect(Object.values(scripts).join(" ")).not.toMatch(/local-acceptance/);
  });
});
