import express from "express";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { createErrorHandler } from "../../src/common/middleware/error-handler.js";
import { verifyPackageBatchActivation } from "../../src/modules/booking/package-batch-authority.js";
import { createPackageConsentRoute } from "../../src/modules/booking/package-consent.route.js";

afterEach(() => vi.unstubAllEnvs());
it.each(["true", "false"])(
  "S6-A13 flag %s cannot compose shipped consent services",
  async (flag) => {
    vi.stubEnv("PACKAGE_CONSENT_ENABLED", flag);
    const app = express();
    app.use(express.json());
    app.use(createPackageConsentRoute());
    app.use(createErrorHandler({ isProduction: true }));
    const response = await request(app)
      .post("/111111111111111111111111/quotes")
      .send({})
      .expect(404);
    expect(response.body.errors[0].code).toBe("PACKAGE_CONSENT_DISABLED");
  },
);
it("S6-A12/A18 shipped unconditional verifier remains unavailable", async () => {
  vi.stubEnv("PACKAGE_CONSENT_ENABLED", "true");
  await expect(verifyPackageBatchActivation()).rejects.toMatchObject({
    code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE",
    statusCode: 503,
  });
});
