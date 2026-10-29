import { Router } from "express";
import { z } from "zod";
import { sendSuccess } from "../../common/http/responses.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { RefundOperationModel } from "./refund-operation.model.js";
import { REFUND_INCIDENT_GUIDANCE } from "./refund-recovery-incident.js";

const querySchema = z
  .object({
    state: z.enum(["OPEN", "RESOLVED"]).default("OPEN"),
    businessId: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

/** Mounted ONLY after the existing live-session/ACTIVE/SUPER_ADMIN finance gate. No writes. */
export function createRefundRecoveryIncidentReadRoute(): Router {
  const router = Router();
  router.get(
    "/",
    (_request, response, next) => {
      response.setHeader("Cache-Control", "private, no-store");
      next();
    },
    validateRequest({ query: querySchema }),
    asyncHandler(async (request, response) => {
      const query = request.validated!.query as z.infer<typeof querySchema>;
      const rows = await RefundOperationModel.find({
        "recoveryIncident.state": query.state,
        ...(query.businessId ? { businessId: query.businessId } : {}),
      })
        .select("_id businessId bookingId sourcePaymentAttemptId recoveryIncident")
        .sort({ "recoveryIncident.lastCheckedAt": 1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit + 1)
        .lean()
        .exec();
      sendSuccess(response, 200, "Refund recovery incidents", {
        incidents: rows.slice(0, query.limit).map((row) => ({
          refundOperationId: String(row._id),
          businessId: row.businessId ? String(row.businessId) : null,
          bookingId: row.bookingId ? String(row.bookingId) : null,
          paymentAttemptId: row.sourcePaymentAttemptId ? String(row.sourcePaymentAttemptId) : null,
          episodeId: String(row.recoveryIncident!.episodeId),
          state: row.recoveryIncident!.state,
          category: row.recoveryIncident!.category,
          observations: row.recoveryIncident!.observations,
          openedAt: row.recoveryIncident!.openedAt,
          lastObservedAt: row.recoveryIncident!.lastObservedAt,
          alertIntentRecordedAt: row.recoveryIncident!.alertedAt ?? null,
          resolvedAt: row.recoveryIncident!.resolvedAt ?? null,
          guidance: REFUND_INCIDENT_GUIDANCE,
        })),
        page: query.page,
        limit: query.limit,
        hasMore: rows.length > query.limit,
      });
    }),
  );
  return router;
}
