import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { sendSuccess } from "../../common/http/responses.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { env } from "../../config/env.js";
import { AuthError } from "../auth/auth.errors.js";
import { Argon2PasswordHasher } from "../auth/password-hasher.js";
import { requireCurrentPassword } from "../auth/require-current-password.js";
import type { UserRepository } from "../user/user.repository.js";
import { CentralPayoutService } from "./central-payout.service.js";
import type { CentralPayoutGateway } from "./central-payout.types.js";
import type { CentralPayoutOperationDocument } from "./central-payout-operation.model.js";
import { StripeCentralPayoutGateway } from "./stripe-central-payout-gateway.js";

export const initiateCentralPayoutBodySchema = z
  .object({
    /** Browser-generated once per confirmation; resubmitting it never creates a second payout. */
    requestId: z.uuid(),
    amountCents: z.number().int().positive().max(99_999_999),
    currency: z.string().regex(/^[a-z]{3}$/, "Use a lowercase ISO currency code"),
    destinationId: z.string().regex(/^ba_[A-Za-z0-9]{1,250}$/, "Choose the linked bank account"),
    currentPassword: z.string().min(1).max(256),
  })
  .strict();
export const centralPayoutParamsSchema = z.object({
  operationId: z.string().regex(/^[a-f0-9]{24}$/),
});
export const centralPayoutListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Masked destination and internal reference only — no account numbers, keys or secrets. */
export const toCentralPayoutOperationDto = (op: CentralPayoutOperationDocument) => ({
  id: String(op._id),
  mode: op.mode,
  amountCents: op.amountCents,
  currency: op.currency,
  destination: { bankName: op.destinationBankName ?? null, last4: op.destinationLast4 },
  state: op.state,
  providerPayoutId: op.providerPayoutId ?? null,
  providerStatus: op.providerStatus ?? null,
  estimatedArrivalAt: op.estimatedArrivalAt?.toISOString() ?? null,
  failureCode: op.failureCode ?? null,
  failureMessage: op.failureMessage ?? null,
  initiatedBy: { userId: String(op.initiatedByUserId), email: op.initiatedByEmail },
  createdAt: op.createdAt.toISOString(),
  lastSyncedAt: op.lastSyncedAt?.toISOString() ?? null,
  audit: op.audit.map((entry) => ({
    at: entry.at.toISOString(),
    kind: entry.kind,
    source: entry.source ?? null,
    detail: entry.detail ?? null,
  })),
});

const actorId = (request: Request): string => {
  const userId = request.auth?.userId;
  if (!userId) throw new AuthError("SESSION_EXPIRED", 401);
  return userId;
};

export const createCentralPayoutService = (
  userRepository: Pick<UserRepository, "findByIdWithPassword">,
  options: {
    gateway?: CentralPayoutGateway;
    liveExecutionEnabled?: boolean;
    businessAttributedUnpaid?: () => Promise<{ currency: string; amountCents: number } | null>;
  } = {},
): CentralPayoutService => {
  const hasher = new Argon2PasswordHasher();
  return new CentralPayoutService({
    gateway: options.gateway ?? new StripeCentralPayoutGateway(),
    policy: {
      liveExecutionEnabled: options.liveExecutionEnabled ?? env.CENTRAL_PAYOUTS_LIVE_ENABLED,
    },
    verifyStepUp: async (userId, password) => {
      const user = await userRepository.findByIdWithPassword(userId);
      if (!user) throw new AuthError("SESSION_EXPIRED", 401);
      await requireCurrentPassword(hasher, user, password);
      return { email: user.normalizedEmail };
    },
    ...(options.businessAttributedUnpaid
      ? { businessAttributedUnpaid: options.businessAttributedUnpaid }
      : {}),
  });
};

/**
 * Mounted inside the `/super-admin` router AFTER its `requireRoles(["SUPER_ADMIN"])` gate, so
 * every route here is Super Admin-only server-side. No Business route reaches this service.
 */
export const createCentralPayoutRouter = (service: CentralPayoutService): Router => {
  const router = Router();

  router.get(
    "/finance/withdrawals/overview",
    asyncHandler(async (_request: Request, response: Response) => {
      sendSuccess(response, 200, "Central Stripe balance", await service.getOverview());
    }),
  );
  router.get(
    "/finance/withdrawals",
    validateRequest({ query: centralPayoutListQuerySchema }),
    asyncHandler(async (request: Request, response: Response) => {
      const query = request.validated?.query as z.infer<typeof centralPayoutListQuerySchema>;
      const page = await service.list(query.page, query.limit);
      sendSuccess(response, 200, "Withdrawals", {
        withdrawals: page.items.map(toCentralPayoutOperationDto),
        pagination: { page: query.page, limit: query.limit, total: page.total },
      });
    }),
  );
  router.get(
    "/finance/withdrawals/:operationId",
    validateRequest({ params: centralPayoutParamsSchema }),
    asyncHandler(async (request: Request, response: Response) => {
      const params = request.validated?.params as z.infer<typeof centralPayoutParamsSchema>;
      const operationId = params.operationId;
      sendSuccess(
        response,
        200,
        "Withdrawal",
        toCentralPayoutOperationDto(await service.get(operationId)),
      );
    }),
  );
  router.post(
    "/finance/withdrawals",
    validateRequest({ body: initiateCentralPayoutBodySchema }),
    asyncHandler(async (request: Request, response: Response) => {
      const body = request.validated?.body as z.infer<typeof initiateCentralPayoutBodySchema>;
      const op = await service.initiate(actorId(request), body);
      sendSuccess(response, 202, "Withdrawal submitted", toCentralPayoutOperationDto(op));
    }),
  );
  router.post(
    "/finance/withdrawals/:operationId/refresh",
    validateRequest({ params: centralPayoutParamsSchema }),
    asyncHandler(async (request: Request, response: Response) => {
      const params = request.validated?.params as z.infer<typeof centralPayoutParamsSchema>;
      const operationId = params.operationId;
      sendSuccess(
        response,
        200,
        "Withdrawal refreshed",
        toCentralPayoutOperationDto(await service.refresh(operationId)),
      );
    }),
  );

  return router;
};
