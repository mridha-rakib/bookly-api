import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPackageCheckoutAvailability } from "../../src/modules/booking/package-checkout-availability.js";

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });

describe("P4K shipped composition stays closed", () => {
  it("reports checkout unavailable without the isolated synthetic setup", async () => {
    await expect(readPackageCheckoutAvailability()).resolves.toBe(false);
  });
  it("no shipped source imports the interactive harness, test helpers or fake gateway", () => {
    for (const file of files("src")) {
      // Import/require specifiers only; existing doc comments legitimately mention test doubles.
      const specifiers = [
        ...readFileSync(file, "utf8").matchAll(
          /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'`]([^"'`]+)["'`]/g,
        ),
      ].map((m) => m[1]);
      for (const specifier of specifiers)
        expect(specifier, file).not.toMatch(/tests\/|p4k-|fake-payment-gateway|fake-tax-gateway/);
    }
  });
  it("the synthetic setup is registered only by the dedicated P4K config", () => {
    for (const config of ["vitest.config.ts", "vitest.booking-local.config.ts"])
      expect(readFileSync(config, "utf8")).not.toContain("p4k-synthetic-authority");
    expect(readFileSync("vitest.p4k-interactive.config.ts", "utf8")).toContain(
      "tests/interactive/p4k-synthetic-authority.setup.ts",
    );
  });
});
