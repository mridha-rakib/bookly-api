/**
 * Phase 4.0 — shipped First-Class activation boundary census.
 *
 * Pins the shipped (src/) composition so that no Consent HTTP, qualified-host, historical
 * verifier or strict-deadline Batch authority can be granted by environment or a new
 * consumer. The reviewed host composition is wired but its release input is unconfigured.
 * Only the reviewed
 * development entry points in dev/ swap these four seams, and only through their resolve
 * hooks. No test double is installed here: every runtime assertion uses the real modules.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTRACT as MAIN_DEVELOPMENT_CONTRACT } from "../../dev/main-purchase/guards.js";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcRoot = join(apiRoot, "src");
const booking = join(srcRoot, "modules", "booking");
const posixPath = (path: string) => relative(apiRoot, path).split(sep).join("/");

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
/** Value and type import/export/require specifiers (doc comments are deliberately ignored). */
const specifiers = (file: string) =>
  [
    ...readFileSync(file, "utf8").matchAll(
      /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'`]([^"'`]+)["'`]/gm,
    ),
  ].map((match) => match[1] as string);
/** Absolute target of a relative specifier, normalised to the .ts source. */
const target = (file: string, specifier: string) =>
  specifier.startsWith(".") ? resolve(dirname(file), specifier.replace(/\.js$/, ".ts")) : null;

const SEAMS = [
  "package-batch-authority.ts",
  "package-consent-http-activation.ts",
  "trusted-time/qualified-host.ts",
  "trusted-time/host-clock.ts",
] as const;

const ACTIVATION_ENVIRONMENT = {
  NODE_ENV: "development",
  // Outside NODE_ENV=test the env schema requires a database URI. Supply a synthetic,
  // never-contacted one instead of relying on whatever an operational .env provides.
  MONGODB_URI: "mongodb://127.0.0.1:1/phase4-activation-boundary-never-connects",
  PACKAGE_CONSENT_ENABLED: "true",
  PACKAGE_CONSENT_QUOTE_LIFETIME_MS: "1800000",
  BOOKLY_MAIN_PURCHASE_CONTRACT: MAIN_DEVELOPMENT_CONTRACT,
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Phase 4.0 shipped seams deny under every plausible activation environment", () => {
  it("environment, development contract marker and approved lifetime grant nothing", async () => {
    for (const [name, value] of Object.entries(ACTIVATION_ENVIRONMENT)) vi.stubEnv(name, value);
    vi.resetModules(); // re-evaluate config/env.ts under the stubbed environment
    const { requireQualifiedConsentHost, requireConsentHostVerificationProfile } = await import(
      "../../src/modules/booking/trusted-time/qualified-host.js"
    );
    const { verifyPackageBatchActivation } = await import(
      "../../src/modules/booking/package-batch-authority.js"
    );
    const { readPackageConsentHttpReadiness, shippedPackageConsentHttpActivation } = await import(
      "../../src/modules/booking/package-consent-http-activation.js"
    );
    const { readPackageCheckoutReadiness } = await import(
      "../../src/modules/booking/package-checkout-availability.js"
    );
    const { observeConsentHost } = await import(
      "../../src/modules/booking/trusted-time/host-clock.js"
    );

    expect(() => requireQualifiedConsentHost()).toThrow(
      expect.objectContaining({
        statusCode: 503,
        details: [expect.objectContaining({ code: "PACKAGE_CONSENT_HOST_UNQUALIFIED" })],
      }),
    );
    expect(() =>
      requireConsentHostVerificationProfile({
        authorityId: MAIN_DEVELOPMENT_CONTRACT,
        hostId: "development:any",
        configurationHash: "a".repeat(64),
        approvedBootId: "aaaa1111-1111-4111-8111-111111111111",
      }),
    ).toThrow(
      expect.objectContaining({
        statusCode: 503,
        details: [
          expect.objectContaining({ code: "PACKAGE_CONSENT_HOST_VERIFICATION_UNAVAILABLE" }),
        ],
      }),
    );
    await expect(verifyPackageBatchActivation()).rejects.toMatchObject({
      code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE",
      statusCode: 503,
    });
    expect(readPackageConsentHttpReadiness(shippedPackageConsentHttpActivation)).toEqual({
      state: "DISABLED",
    });
    await expect(readPackageCheckoutReadiness()).resolves.toEqual({
      available: false,
      reason: "CONSENT_HTTP_DISABLED",
    });
    // Even a composition that enables Consent HTTP stops at the unqualified host.
    await expect(readPackageCheckoutReadiness({ enabled: true })).resolves.toEqual({
      available: false,
      reason: "CONSENT_HOST_UNQUALIFIED",
    });
    // The trusted clock is denied before any boot-id read or chronyc execution.
    await expect(observeConsentHost("b".repeat(64))).rejects.toMatchObject({ statusCode: 503 });
  });

  it("the shipped Consent HTTP activation value is frozen and empty", async () => {
    const { shippedPackageConsentHttpActivation } = await import(
      "../../src/modules/booking/package-consent-http-activation.js"
    );
    expect(Object.isFrozen(shippedPackageConsentHttpActivation)).toBe(true);
    expect(Reflect.ownKeys(shippedPackageConsentHttpActivation)).toEqual([]);
    expect(() => {
      (shippedPackageConsentHttpActivation as { enabled?: boolean }).enabled = true;
    }).toThrow(TypeError);
  });
});

describe("Phase 4.0 shipped authority surface", () => {
  it("authority modules export no grant factory, setter or configuration hook", async () => {
    expect(
      Object.keys(await import("../../src/modules/booking/package-batch-authority.js")).sort(),
    ).toEqual(["PackageBatchActivationUnavailableError", "verifyPackageBatchActivation"]);
    expect(
      Object.keys(await import("../../src/modules/booking/trusted-time/qualified-host.js")).sort(),
    ).toEqual(["requireConsentHostVerificationProfile", "requireQualifiedConsentHost"]);
  });

  it("authority modules read no environment, clock, file system or database", () => {
    for (const file of [
      "package-batch-authority.ts",
      "approved-first-class-release.ts",
      "trusted-time/qualified-host.ts",
      "trusted-time/approved-consent-host-input.ts",
    ]) {
      const path = join(booking, file);
      const code = readFileSync(path, "utf8");
      const allowed =
        file === "package-batch-authority.ts"
          ? [
              "./approved-first-class-release.js",
              "./package-consent-commit-deadline.js",
              "./trusted-time/require-qualified-linux-boot.js",
              "./trusted-time/qualified-host.js",
            ].sort()
          : file === "trusted-time/qualified-host.ts"
            ? ["./approved-consent-host-input.js", "./qualified-host-composition.js"]
            : file === "trusted-time/approved-consent-host-input.ts"
              ? [
                  "./approved-release-loader.js",
                  "./file-audit-key-resolver.js",
                  "./first-class-deployment-authority.js",
                  "./host-authority-history.js",
                  "./qualified-host-composition.js",
                ].sort()
              : file === "approved-first-class-release.ts"
                ? ["./trusted-time/first-class-deployment-authority.js"]
                : [];
      expect(specifiers(path).sort(), file).toEqual(allowed);
      expect(code, file).not.toMatch(/process\.env|\benv\.|Date\.now|new Date|mongoose/);
      expect(code, file).not.toMatch(/readFile/);
    }
  });
});

describe("First-Class deployment authority boundary", () => {
  const trustedTime = join(booking, "trusted-time");

  it("reads only the fixed root-provisioned directory, never environment or request data", () => {
    for (const name of [
      "deployment-attestation.ts",
      "first-class-deployment-authority.ts",
      "protected-authority-files.ts",
      "approved-release-loader.ts",
      "authenticated-release-record.ts",
    ]) {
      const code = readFileSync(join(trustedTime, name), "utf8");
      expect(code, name).not.toMatch(/process\.env|\benv\.|config\/env|mongoose|express/);
    }
    expect(readFileSync(join(trustedTime, "protected-authority-files.ts"), "utf8")).toContain(
      'export const FIRST_CLASS_AUTHORITY_DIRECTORY = "/etc/bookly/first-class-authority";',
    );
  });

  it("only the two approval readers import the process-local authority", () => {
    const importers = sourceFiles(srcRoot)
      .filter((file) =>
        specifiers(file).some((s) => /first-class-deployment-authority(?:\.js)?$/.test(s)),
      )
      .map(posixPath)
      .sort();
    expect(importers).toEqual([
      "src/modules/booking/approved-first-class-release.ts",
      "src/modules/booking/trusted-time/approved-consent-host-input.ts",
    ]);
  });

  it("ships no private key, key generation or synthetic approval in src", () => {
    for (const file of sourceFiles(srcRoot)) {
      const code = readFileSync(file, "utf8");
      expect(code, posixPath(file)).not.toMatch(/BEGIN (?:[A-Z]+ )?PRIVATE KEY|generateKeyPair/);
      expect(code, posixPath(file)).not.toMatch(/synthetic-(?:release|policy|attestation)/);
    }
  });
});

describe("Phase 4.0 shipped wiring census", () => {
  const files = sourceFiles(srcRoot);

  it("no shipped module reaches into dev/ compositions or test code", () => {
    const devRoot = join(apiRoot, "dev") + sep;
    const testsRoot = join(apiRoot, "tests") + sep;
    for (const file of files)
      for (const specifier of specifiers(file)) {
        const absolute = target(file, specifier);
        if (!absolute) continue;
        expect(absolute.startsWith(devRoot), `${posixPath(file)} -> ${specifier}`).toBe(false);
        expect(absolute.startsWith(testsRoot), `${posixPath(file)} -> ${specifier}`).toBe(false);
      }
  });

  it("only the reviewed consumers depend on trusted time; inert building blocks stay unwired", () => {
    const trustedTime = join(booking, "trusted-time") + sep;
    const consumers = new Map<string, Set<string>>();
    for (const file of files) {
      if (file.startsWith(trustedTime)) continue;
      for (const specifier of specifiers(file)) {
        const absolute = target(file, specifier);
        if (!absolute?.startsWith(trustedTime)) continue;
        const module = posixPath(absolute).replace("src/modules/booking/", "");
        consumers.set(module, (consumers.get(module) ?? new Set()).add(posixPath(file)));
      }
    }
    const sorted = Object.fromEntries(
      [...consumers].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v].sort()]),
    );
    // A new consumer, or any shipped import of the registry / Roughtime / dual-authority /
    // chrony-bound building blocks, must be reviewed as part of a coordinated activation.
    expect(sorted).toEqual({
      "trusted-time/host-clock.ts": [
        "src/modules/booking/package-checkout-availability.ts",
        "src/modules/booking/package-consent-certification.ts",
        "src/modules/booking/package-consent-evidence.ts",
        "src/modules/booking/package-consent-protocol.ts",
      ],
      "trusted-time/qualified-host.ts": [
        "src/modules/booking/package-batch-authority.ts",
        "src/modules/booking/package-checkout-availability.ts",
        "src/modules/booking/package-consent-protocol.ts",
        "src/modules/booking/package-purchase-authority.ts",
      ],
      "trusted-time/first-class-deployment-authority.ts": [
        "src/modules/booking/approved-first-class-release.ts",
      ],
      "trusted-time/require-qualified-linux-boot.ts": [
        "src/modules/booking/package-batch-authority.ts",
      ],
    });
  });

  it("only the approved host seam and its release input import the composition", () => {
    // The host seam may import only the composition; no other importer or direct access
    // to registry, history or numerical policy is permitted.
    const inert =
      /(?:host-authority-registry|host-authority-history|qualified-host-composition|consent-clock-policy)(?:\.js)?$/;
    for (const file of files) {
      if (inert.test(file.replace(/\.ts$/, ""))) continue;
      if (posixPath(file) === "src/modules/booking/trusted-time/authenticated-release-record.ts") {
        expect(
          specifiers(file)
            .filter((s) => inert.test(s))
            .sort(),
        ).toEqual([
          "./consent-clock-policy.js",
          "./host-authority-history.js",
          "./host-authority-registry.js",
        ]);
        continue;
      }
      if (posixPath(file) === "src/modules/booking/trusted-time/approved-release-loader.ts") {
        expect(specifiers(file).filter((s) => inert.test(s))).toEqual([
          "./host-authority-registry.js",
        ]);
        continue;
      }
      for (const specifier of specifiers(file))
        if (inert.test(specifier)) {
          const allowed =
            posixPath(file) === "src/modules/booking/trusted-time/approved-consent-host-input.ts"
              ? [
                  "./qualified-host-composition.js",
                  "./host-authority-history.js",
                  "./host-authority-registry.js",
                ]
              : ["./qualified-host-composition.js"];
          expect([
            "src/modules/booking/trusted-time/qualified-host.ts",
            "src/modules/booking/trusted-time/approved-consent-host-input.ts",
          ]).toContain(posixPath(file));
          expect(allowed).toContain(specifier);
        }
    }
  });
});

describe("Phase 4.0 development composition boundary", () => {
  const hooks = (name: string) => readFileSync(join(apiRoot, "dev", name, "hooks.mjs"), "utf8");

  it.each(["main-purchase", "local-acceptance"])(
    "dev/%s swaps exactly the four reviewed seams and nothing else",
    (name) => {
      const source = hooks(name);
      const swapped = [...source.matchAll(/\[\s*"([^"]+\.ts)",\s*"[^"]+\.ts"\s*\]/g)]
        .map((match) => match[1])
        .sort();
      expect(swapped).toEqual([...SEAMS].sort());
    },
  );

  it("only the explicit development script installs a resolve hook; start runs the build", () => {
    const scripts = JSON.parse(readFileSync(join(apiRoot, "package.json"), "utf8"))
      .scripts as Record<string, string>;
    const withHook = Object.entries(scripts)
      .filter(([, command]) =>
        /--import\s+\S*register\.mjs|--loader|--experimental-loader/.test(command),
      )
      .map(([name]) => name);
    expect(withHook).toEqual(["dev:purchase"]);
    expect(scripts["start"]).toBe("node dist/app/server.js");
  });
});
