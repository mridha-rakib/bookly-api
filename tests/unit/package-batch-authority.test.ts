import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PackageBatchActivationUnavailableError,
  verifyPackageBatchActivation,
} from "../../src/modules/booking/package-batch-authority.js";

describe("D1 shipped activation boundary", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("rejects direct invocation without loading persistence or payment dependencies", async () => {
    await expect(verifyPackageBatchActivation()).rejects.toBeInstanceOf(
      PackageBatchActivationUnavailableError,
    );
  });

  it("cannot be enabled by the consent configuration", async () => {
    vi.stubEnv("PACKAGE_CONSENT_ENABLED", "true");
    await expect(verifyPackageBatchActivation()).rejects.toMatchObject({
      code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE",
      statusCode: 503,
    });
  });
});
