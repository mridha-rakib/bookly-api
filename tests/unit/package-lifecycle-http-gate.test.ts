import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { createErrorHandler } from "../../src/common/middleware/error-handler.js";
import { PackageLifecycleHttpController } from "../../src/modules/booking/package-lifecycle-http.controller.js";
import { buildPackageLifecycleHttpServices } from "../../src/modules/booking/package-lifecycle-http.factory.js";
import { lifecycleHttpActions } from "../../src/modules/booking/package-lifecycle-http.schema.js";
import { createPackageViewRoute } from "../../src/modules/package-progress/package-view.route.js";

// Synthetic authentication only. The real production activation authority is NOT mocked.
vi.mock("../../src/modules/auth/auth.middleware.js", async (original) => ({
  ...(await original<object>()),
  createAuthenticateAccessTokenMiddleware:
    () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.auth = { userId: "111111111111111111111111", role: "CUSTOMER", status: "ACTIVE" };
      next();
    },
}));
vi.mock("../../src/modules/booking/package-lifecycle-http.factory.js", () => ({
  buildPackageLifecycleHttpServices: vi.fn(() => {
    throw Error("Production must not compose lifecycle services");
  }),
}));
it.each([...lifecycleHttpActions, "purchase", "consent"])(
  "shipped %s returns 503 before lifecycle composition",
  async (action) => {
    const app = express();
    app.use(express.json());
    app.use("/package-views", createPackageViewRoute());
    app.use(createErrorHandler({ isProduction: true }));
    const res = await request(app).post(`/package-views/actions/${action}`).send({}).expect(503);
    expect(res.body.errors[0].code).toBe("PACKAGE_BATCH_ACTIVATION_UNAVAILABLE");
    expect(buildPackageLifecycleHttpServices).not.toHaveBeenCalled();
  },
);
it("direct controller use cannot bypass authority or inspect dependencies", async () => {
  const controller = new PackageLifecycleHttpController(
    new Proxy({} as never, {
      get() {
        throw Error("dependency touched");
      },
    }),
  );
  await expect(controller.execute({} as never, {} as never)).rejects.toMatchObject({
    code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE",
  });
});
