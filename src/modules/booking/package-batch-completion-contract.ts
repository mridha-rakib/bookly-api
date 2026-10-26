import { Types } from "mongoose";
import { z } from "zod";
import { findFinancialContractInvariantViolation } from "./financial-contract.js";

const id = z.custom<Types.ObjectId>((v) => v instanceof Types.ObjectId);
const cents = z.number().int().nonnegative().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const batchFinancialContractSchema = z
  .object({
    version: z.literal(2),
    productKind: z.literal("PACKAGE_PURCHASE"),
    classification: z.enum(["FIRST", "RETURNING"]),
    idempotencyKey: z.string().min(1),
    bookingId: id,
    customerUserId: id,
    businessId: id,
    businessClientId: id,
    currency: z.literal("EUR"),
    eligibleBasisCents: cents,
    requiredUpfrontCents: cents,
    promoDiscountCents: z.literal(0),
    onlineChargeCents: cents,
    travelFeeCents: cents,
    packageBundlePriceCents: cents,
    bookingTotalCents: cents,
    upfrontLedgerType: z.enum(["PLATFORM_FEE", "DEPOSIT"]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const violation = findFinancialContractInvariantViolation(value);
    if (violation) ctx.addIssue({ code: "custom", message: violation });
  });
export const batchFinanceSchema = z
  .object({ version: z.literal(1), preparationHash: hash, contract: batchFinancialContractSchema })
  .strict();
export type BatchFinance = z.output<typeof batchFinanceSchema>;

export const batchDeliveryTaskSchema = z
  .object({
    lifecycleVersion: z.literal(0),
    key: z.string().min(1),
    bookingId: id,
    startAt: z.date(),
    endAt: z.date(),
    port: z.enum(["CALENDAR", "OWNER_EMAIL"]),
    state: z.enum(["PENDING", "PROCESSING", "RETRY", "DONE", "SKIPPED", "BLOCKED_UNVERIFIED"]),
    token: z.uuid().optional(),
    attempts: cents,
    nextDue: z.date(),
  })
  .strict();
export type BatchDeliveryTask = z.output<typeof batchDeliveryTaskSchema>;
export const batchCompletionSchema = z
  .object({
    version: z.literal(1),
    state: z.literal("PREPARATION_ONLY_COMPLETE_BATCH"),
    activation: z.literal("SYNTHETIC_AUTHORITY_NOT_PRODUCTION_CONSENT"),
    preparationHash: hash,
    financeHash: hash,
    paymentAttemptId: id.optional(),
    ledgerId: id.optional(),
    emails: z.array(z.object({ id, dedupeKey: z.string(), payloadHash: hash }).strict()),
    reminders: z.array(z.object({ id, dedupeKey: z.string() }).strict()),
    tasks: z.array(
      z
        .object({
          lifecycleVersion: z.literal(0),
          key: z.string(),
          bookingId: id,
          port: z.enum(["CALENDAR", "OWNER_EMAIL"]),
          startAt: z.date(),
          endAt: z.date(),
        })
        .strict(),
    ),
  })
  .strict();
export type BatchCompletion = z.output<typeof batchCompletionSchema>;
