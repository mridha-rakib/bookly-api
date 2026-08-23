import { z } from "zod";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const isoDateTimeSchema = z.string().datetime({ offset: true }).or(z.string().datetime());

export const financeBusinessParamsSchema = z.object({ businessId: objectIdSchema }).strict();

const paginationQuerySchema = z.object({
  page: z.string().regex(/^\d+$/, "Invalid page").optional(),
  limit: z.string().regex(/^\d+$/, "Invalid limit").optional(),
});

const periodQuerySchema = z.object({
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
});

export const financeSummaryQuerySchema = periodQuerySchema.strict().transform((value) => ({
  from: new Date(value.from),
  to: new Date(value.to),
}));

export const financeTransactionsQuerySchema = paginationQuerySchema
  .extend(periodQuerySchema.shape)
  .strict()
  .transform((value) => ({
    from: new Date(value.from),
    to: new Date(value.to),
    page: value.page ? Math.max(1, Number(value.page)) : 1,
    limit: value.limit ? Math.min(100, Math.max(1, Number(value.limit))) : 20,
  }));

export const financePayoutHistoryQuerySchema = paginationQuerySchema
  .strict()
  .transform((value) => ({
    page: value.page ? Math.max(1, Number(value.page)) : 1,
    limit: value.limit ? Math.min(100, Math.max(1, Number(value.limit))) : 20,
  }));

export type FinanceBusinessParams = z.infer<typeof financeBusinessParamsSchema>;
export type FinanceSummaryQuery = z.infer<typeof financeSummaryQuerySchema>;
export type FinanceTransactionsQuery = z.infer<typeof financeTransactionsQuerySchema>;
export type FinancePayoutHistoryQuery = z.infer<typeof financePayoutHistoryQuerySchema>;

// --- Batch 8: Super Admin platform-wide finance -------------------------------------------

const platformTransactionTypes = [
  "NO_SHOW_FEE",
  "CANCELLATION_FEE",
  "PLATFORM_FEE",
  "REFUND",
] as const;

export const platformTransactionsQuerySchema = paginationQuerySchema
  .extend(periodQuerySchema.shape)
  .extend({ types: z.string().optional() })
  .strict()
  .transform((value) => ({
    from: new Date(value.from),
    to: new Date(value.to),
    page: value.page ? Math.max(1, Number(value.page)) : 1,
    limit: value.limit ? Math.min(100, Math.max(1, Number(value.limit))) : 20,
    types: value.types
      ? (value.types
          .split(",")
          .filter((t) => (platformTransactionTypes as readonly string[]).includes(t)) as Array<
          (typeof platformTransactionTypes)[number]
        >)
      : undefined,
  }));

export const executePayoutBodySchema = z
  .object({
    providerReference: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export type PlatformTransactionsQuery = z.infer<typeof platformTransactionsQuerySchema>;
export type ExecutePayoutBody = z.infer<typeof executePayoutBodySchema>;
