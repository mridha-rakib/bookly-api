import { z } from "zod";
import {
  isBoundedPlatformFinanceWindow,
  platformRangeFrom,
  platformRangeTo,
} from "../../common/time/platform-reporting.js";

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

/**
 * P2.2.2 (E17) — Super Admin platform Finance periods. `from`/`to` are inclusive Cyprus calendar
 * dates (`YYYY-MM-DD`), converted here to the Europe/Nicosia `[from, to)` UTC window (DST-aware,
 * shared with Overview/Analytics via platform-reporting.ts). Exact ISO instants remain accepted
 * as given. Business Owner and per-Business Finance keep `financeSummaryQuerySchema` /
 * `financeTransactionsQuerySchema` above, unchanged.
 */
const platformPeriodBoundarySchema = z.string().date().or(isoDateTimeSchema);
const platformPeriodQuerySchema = z.object({
  from: platformPeriodBoundarySchema,
  to: platformPeriodBoundarySchema,
});
const validPlatformWindow = (value: { from: Date; to: Date }) =>
  isBoundedPlatformFinanceWindow(value.from, value.to);
const platformWindowMessage = {
  message: "Choose an ordered date range of at most 92 days (Cyprus time)",
  path: ["from"],
};

export const superAdminFinanceSummaryQuerySchema = platformPeriodQuerySchema
  .strict()
  .transform((value) => ({ from: platformRangeFrom(value.from), to: platformRangeTo(value.to) }))
  .refine(validPlatformWindow, platformWindowMessage);

export const platformTransactionsQuerySchema = paginationQuerySchema
  .extend(platformPeriodQuerySchema.shape)
  .extend({ types: z.string().optional() })
  .strict()
  .transform((value) => ({
    from: platformRangeFrom(value.from),
    to: platformRangeTo(value.to),
    page: value.page ? Math.max(1, Number(value.page)) : 1,
    limit: value.limit ? Math.min(100, Math.max(1, Number(value.limit))) : 20,
    types: value.types
      ? (value.types
          .split(",")
          .filter((t) => (platformTransactionTypes as readonly string[]).includes(t)) as Array<
          (typeof platformTransactionTypes)[number]
        >)
      : undefined,
  }))
  .refine(validPlatformWindow, platformWindowMessage);

/** P1.9 — the platform transaction log's CSV export: the same period and type filter as the
 * paginated list, without page/limit (the export walks every matching page server-side). */
export const platformTransactionsExportQuerySchema = platformPeriodQuerySchema
  .extend({ types: z.string().optional() })
  .strict()
  .transform((value) => ({
    // P2.2.2 — the same conversion as the table's schema, so table and CSV select one window.
    from: platformRangeFrom(value.from),
    to: platformRangeTo(value.to),
    types: value.types
      ? (value.types
          .split(",")
          .filter((t) => (platformTransactionTypes as readonly string[]).includes(t)) as Array<
          (typeof platformTransactionTypes)[number]
        >)
      : undefined,
  }))
  .refine(validPlatformWindow, platformWindowMessage);

export type PlatformTransactionsExportQuery = z.infer<typeof platformTransactionsExportQuerySchema>;

export const executePayoutBodySchema = z
  .object({
    providerReference: z.string().trim().min(1).max(200).optional(),
    // Finance Gap 02 — the exact amount transferred externally and the payable snapshot it was
    // read from (GET .../finance/payable `netCents` + `snapshotDigest`). Required.
    expectedNetCents: z.number().int().positive().safe(),
    snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type PlatformTransactionsQuery = z.infer<typeof platformTransactionsQuerySchema>;
export type ExecutePayoutBody = z.infer<typeof executePayoutBodySchema>;
