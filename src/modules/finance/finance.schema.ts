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
