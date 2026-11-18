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
import {
  type CentralPayoutGateway,
  providerPayoutStatuses,
  STRIPE_TEST_DEFAULT_DESTINATION,
} from "./central-payout.types.js";
import type { CentralPayoutOperationDocument } from "./central-payout-operation.model.js";
import { MAX_PAGES_PER_RUN } from "./payout-reconciliation.js";
import { StripeCentralPayoutGateway } from "./stripe-central-payout-gateway.js";
import { payoutLinkages } from "./stripe-payout-observation.model.js";

export const initiateCentralPayoutBodySchema = z
  .object({
    /** Browser-generated once per confirmation; resubmitting it never creates a second payout. */
    requestId: z.uuid(),
    amountCents: z.number().int().positive().max(99_999_999),
    currency: z.string().regex(/^[a-z]{3}$/, "Use a lowercase ISO currency code"),
    /** A linked `ba_...` bank account, or the TEST-only Stripe default marker (the service refuses
     * the marker for any LIVE key, mode or account). */
    destinationId: z.union([
      z.string().regex(/^ba_[A-Za-z0-9]{1,250}$/, "Choose the linked bank account"),
      z.literal(STRIPE_TEST_DEFAULT_DESTINATION),
    ]),
    currentPassword: z.string().min(1).max(256),
    /** CW-1 — the eligibility digest the Super Admin reviewed (GET .../eligibility). */
    eligibilityDigest: z.string().regex(/^[a-f0-9]{64}$/, "Review the eligible amount first"),
  })
  .strict();
export const centralPayoutParamsSchema = z.object({
  operationId: z.string().regex(/^[a-f0-9]{24}$/),
});
/** FG03B-1 — bounded history read: at most MAX_PAGES_PER_RUN Stripe pages per request. */
export const providerHistorySyncBodySchema = z
  .object({ maxPages: z.number().int().min(1).max(MAX_PAGES_PER_RUN).optional() })
  .strict();
/** FG03B-2 — read-only observed-payout review filters. Dates are Stripe creation days (UTC). */
export const observedPayoutQuerySchema = z
  .object({
    mode: z.enum(["TEST", "LIVE"]).optional(),
    linkage: z.enum(payoutLinkages).optional(),
    status: z.enum(providerPayoutStatuses).optional(),
    needsReview: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === "true")),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: "`from` must not be after `to`",
    path: ["from"],
  });
const DAY_MS = 24 * 60 * 60 * 1000;

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
  destination: {
    bankName: op.destinationBankName ?? null,
    last4: op.destinationLast4,
    /** TEST only: Stripe chose the TEST account's default destination; no bank details exist. */
    stripeTestDefault: op.destinationId === STRIPE_TEST_DEFAULT_DESTINATION,
  },
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
    historySyncEnabled?: boolean;
    businessAttributedUnpaid?: () => Promise<{ currency: string; amountCents: number } | null>;
  } = {},
): CentralPayoutService => {
  const hasher = new Argon2PasswordHasher();
  return new CentralPayoutService({
    gateway: options.gateway ?? new StripeCentralPayoutGateway(),
    policy: {
      liveExecutionEnabled: options.liveExecutionEnabled ?? env.CENTRAL_PAYOUTS_LIVE_ENABLED,
      historySyncEnabled: options.historySyncEnabled ?? env.CENTRAL_PAYOUT_HISTORY_SYNC_ENABLED,
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
    "/finance/withdrawals/bank-account",
    asyncHandler(async (_request: Request, response: Response) => {
      sendSuccess(response, 200, "Platform bank account", await service.getBankAccountSummary());
    }),
  );

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
  // CW-1 — the authoritative withdrawal eligibility (Super Admin router gate). Read-only.
  router.get(
    "/finance/withdrawals/eligibility",
    asyncHandler(async (_request: Request, response: Response) => {
      sendSuccess(response, 200, "Withdrawal eligibility", await service.getEligibility());
    }),
  );
  // FG03B-2 — read-only review of observed Stripe payouts (database only, current verified
  // account only, masked). Registered before `/:operationId`. No assignment or override exists.
  router.get(
    "/finance/withdrawals/provider-payouts",
    validateRequest({ query: observedPayoutQuerySchema }),
    asyncHandler(async (request: Request, response: Response) => {
      const query = request.validated?.query as z.infer<typeof observedPayoutQuerySchema>;
      sendSuccess(
        response,
        200,
        "Observed Stripe payouts",
        await service.listObservedPayouts({
          mode: query.mode,
          linkage: query.linkage,
          status: query.status,
          needsReview: query.needsReview,
          createdFrom: query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined,
          createdBefore: query.to
            ? new Date(new Date(`${query.to}T00:00:00.000Z`).getTime() + DAY_MS)
            : undefined,
          page: query.page,
          limit: query.limit,
        }),
      );
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
  // FG03B-1 — bounded, resumable, audited Stripe payout history read. Super Admin only (router
  // gate) and refused unless CENTRAL_PAYOUT_HISTORY_SYNC_ENABLED is set for the deployment.
  router.post(
    "/finance/withdrawals/provider-history/sync",
    validateRequest({ body: providerHistorySyncBodySchema }),
    asyncHandler(async (request: Request, response: Response) => {
      const body = request.validated?.body as z.infer<typeof providerHistorySyncBodySchema>;
      sendSuccess(
        response,
        200,
        "Stripe payout history read",
        await service.syncProviderHistory(actorId(request), { maxPages: body.maxPages }),
      );
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
