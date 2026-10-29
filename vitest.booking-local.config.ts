import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

/** Explicit isolated engineering lane. No application server, real Chrony or rollout grant.
 * Database suites launch their own disposable replicas; they do not use Compose data.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      pool: "forks",
      fileParallelism: false,
      allowOnly: false,
      passWithNoTests: false,
      include: [
        "tests/unit/package-consent-host.test.ts",
        "tests/unit/package-consent-host-integrity.test.ts",
        "tests/unit/chrony-48-tracking.test.ts",
        "tests/unit/consent-host-readiness.test.ts",
        "tests/unit/consent-host-authority-registry.test.ts",
        "tests/unit/package-consent-commit-deadline.test.ts",
        "tests/unit/package-purchase-gates.test.ts",
        "tests/unit/package-checkout-availability.test.ts",
        "tests/unit/package-checkout-availability-matrix.test.ts",
        "tests/unit/p4k-console-isolation.test.ts",
        "tests/integration/database/package-consent-http.integration.test.ts",
        "tests/integration/database/package-consent-production-proof.integration.test.ts",
        "tests/integration/database/package-batch-financial-database.integration.test.ts",
        "tests/integration/database/package-purchase-completion-view.integration.test.ts",
        "tests/integration/database/package-lifecycle-database.integration.test.ts",
        "tests/integration/database/package-final-next.integration.test.ts",
      ],
    },
  }),
);
