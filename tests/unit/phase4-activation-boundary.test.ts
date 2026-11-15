/**
 * Phase 4.0 — shipped First-Class activation boundary census.
 *
 * Pins the shipped (src/) composition so that no Consent HTTP, qualified-host, historical
 * verifier or strict-deadline Batch authority can be granted by environment, by a new
 * consumer, or by an accidentally wired inert building block. Only the reviewed
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
    for (const file of ["package-batch-authority.ts", "trusted-time/qualified-host.ts"]) {
      const path = join(booking, file);
      const code = readFileSync(path, "utf8");
      expect(
        specifiers(path).filter((s) => !s.endsWith("/common/errors/app-error.js")),
        file,
      ).toEqual([]);
      expect(code, file).not.toMatch(/process\.env|\benv\.|Date\.now|new Date|readFile|mongoose/);
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
        "src/modules/booking/package-consent-certification.ts",
        "src/modules/booking/package-consent-evidence.ts",
        "src/modules/booking/package-consent-protocol.ts",
      ],
      "trusted-time/qualified-host.ts": [
        "src/modules/booking/package-checkout-availability.ts",
        "src/modules/booking/package-consent-protocol.ts",
        "src/modules/booking/package-purchase-authority.ts",
      ],
    });
  });

  it("the inert registry/history/policy/composition blocks have no shipped importer at all", () => {
    // Phase 4.1: these four may import one another; nothing else in src (including the
    // deny-only qualified-host seam) may import them until a reviewed activation release.
    const inert =
      /(?:host-authority-registry|host-authority-history|qualified-host-composition|consent-clock-policy)(?:\.js)?$/;
    for (const file of files) {
      if (inert.test(file.replace(/\.ts$/, ""))) continue;
      for (const specifier of specifiers(file))
        expect(specifier, posixPath(file)).not.toMatch(inert);
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
