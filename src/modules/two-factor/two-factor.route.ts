import { type Request, type RequestHandler, Router } from "express";
import { z } from "zod";

import { sendSuccess } from "../../common/http/responses.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { setRefreshCookie } from "../auth/auth.cookies.js";
import { AuthError } from "../auth/auth.errors.js";
import { requireActiveUser, requireRoles } from "../auth/auth.middleware.js";
import type { TokenService } from "../auth/token.service.js";
import { professionalRoles } from "../user/user.types.js";
import { clearChallengeCookie, readChallengeCookie } from "./two-factor.http.js";
import { TwoFactorService } from "./two-factor.service.js";

const code = z
  .string()
  .trim()
  .regex(/^(?:\d{6}|[a-f0-9]{32})$/);
const proofSchema = z
  .object({ code, replaceRecoveryCodes: z.boolean().optional() })
  .strict()
  .refine(
    (input) => !input.replaceRecoveryCodes || /^[a-f0-9]{32}$/.test(input.code),
    "Replacing recovery codes during sign-in requires an unused recovery code",
  );
const enrollmentSchema = z
  .object({
    setupId: z.string().regex(/^[a-f0-9]{64}$/),
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/),
  })
  .strict();

const actorId = (request: Request): string => {
  if (!request.auth) throw new AuthError("SESSION_EXPIRED", 401);
  return request.auth.userId;
};

export const createTwoFactorRoute = (
  tokens: TokenService,
  authenticate: RequestHandler,
  limiter: RequestHandler,
): Router => {
  const router = Router();
  const service = new TwoFactorService();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(limiter);
  router.get(
    "/challenge",
    asyncHandler(async (req, res) => {
      sendSuccess(
        res,
        200,
        "Verification required",
        await service.challengeStatus(readChallengeCookie(req)),
      );
    }),
  );
  router.delete(
    "/challenge",
    asyncHandler(async (req, res) => {
      const token = readChallengeCookie(req);
      await service.cancel(token);
      clearChallengeCookie(res);
      sendSuccess(res, 200, "Verification cancelled", {});
    }),
  );
  router.post(
    "/verify",
    validateRequest({ body: proofSchema }),
    asyncHandler(async (req, res) => {
      const input = req.validated?.body as z.infer<typeof proofSchema>;
      const result = await service.verifyLogin(
        readChallengeCookie(req),
        input.code,
        tokens,
        {
          ...(req.ip ? { ipAddress: req.ip } : {}),
          ...(req.headers["user-agent"] ? { userAgent: req.headers["user-agent"] } : {}),
        },
        input.replaceRecoveryCodes === true,
      );
      clearChallengeCookie(res);
      setRefreshCookie(res, result.refreshToken);
      const { refreshToken: _, ...auth } = result;
      sendSuccess(res, 200, "Sign-in verified", auth);
    }),
  );
  router.use(authenticate, requireActiveUser(), requireRoles(professionalRoles));
  router.get(
    "/status",
    asyncHandler(async (req, res) => {
      sendSuccess(res, 200, "Two-factor status", await service.status(actorId(req)));
    }),
  );
  router.post(
    "/enroll",
    validateRequest({ body: z.object({}).strict() }),
    asyncHandler(async (req, res) => {
      sendSuccess(
        res,
        200,
        "Authenticator setup started",
        await service.start(actorId(req), req.auth?.sessionFamilyId),
      );
    }),
  );
  router.post(
    "/activate",
    validateRequest({ body: enrollmentSchema }),
    asyncHandler(async (req, res) => {
      const input = req.validated?.body as z.infer<typeof enrollmentSchema>;
      sendSuccess(
        res,
        200,
        "Two-factor enabled; save your recovery codes",
        await service.activate(actorId(req), req.auth?.sessionFamilyId, input.setupId, input.code),
      );
    }),
  );
  for (const action of ["disable", "regenerate"] as const) {
    const schema = z
      .object({ code, confirmation: z.literal(action === "disable" ? "DISABLE" : "REPLACE") })
      .strict();
    router.post(
      `/${action}`,
      validateRequest({ body: schema }),
      asyncHandler(async (req, res) => {
        const input = req.validated?.body as z.infer<typeof schema>;
        sendSuccess(
          res,
          200,
          "Security updated; sign in again",
          await service.manage(actorId(req), req.auth?.sessionFamilyId, input.code, action),
        );
      }),
    );
  }
  return router;
};
