import type { Types } from "mongoose";

import { BookingError } from "./booking.errors.js";
import { DEPOSIT_MAX_CENTS, DEPOSIT_MIN_CENTS } from "./booking.types.js";

/**
 * P1 — Financial Contract V2. One immutable, server-side snapshot of the money terms a logical
 * customer booking operation (normal booking or package purchase) was classified and priced
 * under. It is written onto the BookingCreationClaim BEFORE any provider charge (so it survives
 * HTTP retry, 3DS, crashes and recovery), correlated onto the PaymentAttempt/PI metadata, and
 * copied onto the final Booking. A resumed operation that would compute different terms fails
 * closed (BOOKING_FINANCIAL_CONTRACT_CONFLICT) — it never silently becomes RETURNING, never
 * switches product kind, and never charges a different amount.
 *
 * Classification comes ONLY from the customer↔business financial relationship
 * (BusinessClient.financialRelationship — see client.model.ts), never from `activatedAt`.
 */
export const FINANCIAL_CONTRACT_VERSION = 2 as const;

export const financialContractProductKinds = ["NORMAL_BOOKING", "PACKAGE_PURCHASE"] as const;
export type FinancialContractProductKind = (typeof financialContractProductKinds)[number];

export const relationshipClassifications = ["FIRST", "RETURNING"] as const;
export type RelationshipClassification = (typeof relationshipClassifications)[number];

/** Which ledger type owns the upfront charge. FIRST is always Bookly's PLATFORM_FEE; RETURNING
 * keeps the pre-P3 Business-owned DEPOSIT. */
export type UpfrontLedgerType = "PLATFORM_FEE" | "DEPOSIT";

export type FinancialContractV2 = {
  version: typeof FINANCIAL_CONTRACT_VERSION;
  productKind: FinancialContractProductKind;
  classification: RelationshipClassification;
  idempotencyKey: string;
  bookingId: Types.ObjectId;
  customerUserId: Types.ObjectId;
  businessId: Types.ObjectId;
  businessClientId: Types.ObjectId;
  currency: "EUR";
  /** FIRST: the canonical first-upfront basis (normal = service + eligible add-ons − service
   * discount; package = Service.packagePricing.bundlePriceCents only). RETURNING: the legacy
   * deposit basis the current (pre-P3) returning deposit is computed from. Travel is never
   * included. */
  eligibleBasisCents: number;
  /** The pre-promo upfront obligation (== Booking.financials.depositCents). */
  requiredUpfrontCents: number;
  /** Legacy (pre-P2) promo semantics: the promo discounts only the upfront charge. */
  promoDiscountCents: number;
  /** What is actually charged online now (== PaymentAttempt.expectedAmountCents when > 0). */
  onlineChargeCents: number;
  travelFeeCents: number;
  /** Package purchase only — the bundle price snapshot the FIRST basis was taken from. */
  packageBundlePriceCents?: number | undefined;
  /** Booking.financials.totalCents at classification time — pricing snapshot correlation. */
  bookingTotalCents: number;
  upfrontLedgerType: UpfrontLedgerType;
};

/**
 * Canonical FIRST upfront formula — integer cents only:
 *   20% of the eligible basis (round half up), floored at €5, capped at €35, and NEVER above the
 *   eligible basis itself (fixes the low-total case where the €5 minimum exceeded the basis).
 * A zero basis is a zero obligation — never an invented €5 charge.
 *
 * For every basis >= €5 this is numerically identical to the legacy
 * BookingService.calculateBookingDepositCents (Math.round(basis * 0.2) never meets an exact .5
 * for an integer basis, so integer round-half-up matches it exactly) — only the cap-to-basis
 * rule differs.
 */
export const calculateFirstUpfrontCents = (eligibleBasisCents: number): number => {
  if (!Number.isSafeInteger(eligibleBasisCents) || eligibleBasisCents < 0) {
    throw new BookingError("BOOKING_INVALID_DEPOSIT_BASIS", 400);
  }
  if (eligibleBasisCents === 0) return 0;

  const percentageCents = Math.floor((eligibleBasisCents * 20 + 50) / 100);
  const bounded = Math.min(DEPOSIT_MAX_CENTS, Math.max(DEPOSIT_MIN_CENTS, percentageCents));
  return Math.min(eligibleBasisCents, bounded);
};

/** Immutable-field comparison for a resumed logical operation. Returns the first mismatching
 * field name, or undefined when the two contracts describe the same money terms. */
export const findFinancialContractMismatch = (
  existing: FinancialContractV2,
  candidate: FinancialContractV2,
): keyof FinancialContractV2 | undefined => {
  const comparisons: Array<[keyof FinancialContractV2, unknown, unknown]> = [
    ["version", existing.version, candidate.version],
    ["productKind", existing.productKind, candidate.productKind],
    ["classification", existing.classification, candidate.classification],
    ["idempotencyKey", existing.idempotencyKey, candidate.idempotencyKey],
    ["bookingId", String(existing.bookingId), String(candidate.bookingId)],
    ["customerUserId", String(existing.customerUserId), String(candidate.customerUserId)],
    ["businessId", String(existing.businessId), String(candidate.businessId)],
    ["businessClientId", String(existing.businessClientId), String(candidate.businessClientId)],
    ["currency", existing.currency, candidate.currency],
    ["eligibleBasisCents", existing.eligibleBasisCents, candidate.eligibleBasisCents],
    ["requiredUpfrontCents", existing.requiredUpfrontCents, candidate.requiredUpfrontCents],
    ["promoDiscountCents", existing.promoDiscountCents, candidate.promoDiscountCents],
    ["onlineChargeCents", existing.onlineChargeCents, candidate.onlineChargeCents],
    ["travelFeeCents", existing.travelFeeCents, candidate.travelFeeCents],
    [
      "packageBundlePriceCents",
      existing.packageBundlePriceCents ?? null,
      candidate.packageBundlePriceCents ?? null,
    ],
    ["bookingTotalCents", existing.bookingTotalCents, candidate.bookingTotalCents],
    ["upfrontLedgerType", existing.upfrontLedgerType, candidate.upfrontLedgerType],
  ];
  return comparisons.find(([, left, right]) => left !== right)?.[0];
};
