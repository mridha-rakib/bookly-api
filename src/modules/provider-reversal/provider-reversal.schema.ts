import { z } from "zod";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

const paginationShape = {
  page: z.string().regex(/^\d+$/, "Invalid page").optional(),
  limit: z.string().regex(/^\d+$/, "Invalid limit").optional(),
};

const toPagination = (value: { page?: string | undefined; limit?: string | undefined }) => ({
  page: value.page ? Math.max(1, Number(value.page)) : 1,
  limit: value.limit ? Math.min(100, Math.max(1, Number(value.limit))) : 20,
});

export const disputeListQuerySchema = z
  .object({
    ...paginationShape,
    businessId: objectIdSchema.optional(),
    reconciliationOnly: z.enum(["true", "false"]).optional(),
  })
  .strict()
  .transform((value) => ({
    ...toPagination(value),
    businessId: value.businessId,
    reconciliationOnly: value.reconciliationOnly === "true",
  }));

/** A provider dispute id (dp_…) or the local record id. */
export const disputeParamsSchema = z
  .object({ disputeId: z.string().regex(/^[A-Za-z0-9_]{3,100}$/, "Invalid dispute id") })
  .strict();

export const externalRefundListQuerySchema = z
  .object({
    ...paginationShape,
    businessId: objectIdSchema.optional(),
    state: z.enum(["ACCOUNTED", "INVESTIGATION"]).optional(),
  })
  .strict()
  .transform((value) => ({
    ...toPagination(value),
    businessId: value.businessId,
    state: value.state,
  }));

export const webhookEventListQuerySchema = z
  .object({
    ...paginationShape,
    status: z.enum(["RECEIVED", "PROCESSING", "PROCESSED", "RETRYABLE", "FAILED"]).optional(),
  })
  .strict()
  .transform((value) => ({ ...toPagination(value), status: value.status }));

export const webhookEventParamsSchema = z
  .object({ eventId: z.string().regex(/^evt_[A-Za-z0-9_]{1,100}$/, "Invalid event id") })
  .strict();

/** Business Owner reversal lists: pagination only — always scoped to the owned businessId. */
export const businessReversalListQuerySchema = z
  .object(paginationShape)
  .strict()
  .transform(toPagination);

export type DisputeListQuery = z.infer<typeof disputeListQuerySchema>;
export type DisputeParams = z.infer<typeof disputeParamsSchema>;
export type ExternalRefundListQuery = z.infer<typeof externalRefundListQuerySchema>;
export type WebhookEventListQuery = z.infer<typeof webhookEventListQuerySchema>;
export type WebhookEventParams = z.infer<typeof webhookEventParamsSchema>;
export type BusinessReversalListQuery = z.infer<typeof businessReversalListQuerySchema>;
