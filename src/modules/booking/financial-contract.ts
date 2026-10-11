import type { Types } from "mongoose";

import type { PromoType } from "../promo/promo.types.js";
import { BookingError } from "./booking.errors.js";
import { DEPOSIT_MAX_CENTS, DEPOSIT_MIN_CENTS } from "./booking.types.js";

/**
 * P1 — Financial Contract. One immutable, server-side snapshot of the money terms a logical
 * customer booking operation (normal booking or package purchase) was classified and priced
 * under. It is written onto the BookingCreationClaim BEFORE any provider charge (so it survives
 * HTTP retry, 3DS, crashes and recovery), correlated onto the PaymentAttempt/PI metadata, and
 * copied onto the final Booking. A resumed operation that would compute different terms fails
 * closed (BOOKING_FINANCIAL_CONTRACT_CONFLICT) — it never silently becomes RETURNING, never
 * switches product kind, and never charges a different amount.
 *
 * Classification comes ONLY from the customer↔business financial relationship
 * (BusinessClient.financialRelationship — see client.model.ts), never from `activatedAt`.
 *
 * VERSIONS (both stay readable; a recorded contract is never rewritten):
 *  - V2 (P1): every package purchase, and normal bookings recorded before P2. Legacy promo
 *    semantics — a promo discounted only the upfront charge
 *    (`onlineChargeCents + promoDiscountCents === requiredUpfrontCents`).
 *  - V3 (P2): every new NORMAL booking. A promo discounts the booking PRICE first
 *    (`eligibleBasisCents = promoEligibleBaseCents − promoDiscountCents`), the upfront is
 *    computed from that discounted basis, and the whole upfront is charged online. The promo's
 *    identity is frozen with its economics, so an edited/replaced code can never pass as an
 *    amount-only match. Business-funded.
 */
export const FINANCIAL_CONTRACT_V2 = 2 as const;
export const FINANCIAL_CONTRACT_V3 = 3 as const;
export const financialContractVersions = [FINANCIAL_CONTRACT_V2, FINANCIAL_CONTRACT_V3] as const;
export type FinancialContractVersion = (typeof financialContractVersions)[number];

export const financialContractProductKinds = ["NORMAL_BOOKING", "PACKAGE_PURCHASE"] as const;
export type FinancialContractProductKind = (typeof financialContractProductKinds)[number];

export const relationshipClassifications = ["FIRST", "RETURNING"] as const;
export type RelationshipClassification = (typeof relationshipClassifications)[number];

/** Which ledger type owns the upfront charge. FIRST is always Bookly's PLATFORM_FEE; RETURNING
 * keeps the pre-P3 Business-owned DEPOSIT. */
export type UpfrontLedgerType = "PLATFORM_FEE" | "DEPOSIT";

/** V3 only — the frozen identity of the applied promo. `normalizedCode` is the canonical code
 * identity (PromoCode.normalizedCode); `value` is the promo definition at establishment time
 * (PERCENTAGE: percent; FIXED: integer cents). */
export type FinancialContractPromo = {
  promoId: Types.ObjectId;
  normalizedCode: string;
  type: PromoType;
  value: number;
  fundingOwner: "BUSINESS";
};

export type FinancialContract = {
  version: FinancialContractVersion;
  productKind: FinancialContractProductKind;
  classification: RelationshipClassification;
  idempotencyKey: string;
  bookingId: Types.ObjectId;
  customerUserId: Types.ObjectId;
  businessId: Types.ObjectId;
  businessClientId: Types.ObjectId;
  currency: "EUR";
  /** FIRST: the canonical first-upfront basis (normal = service + eligible add-ons − service
   * discount [V3: − promo discount]; package = Service.packagePricing.bundlePriceCents only).
   * RETURNING: the basis the current (pre-P3) returning deposit is computed from [V3: after the
   * promo discount]. Travel is never included. */
  eligibleBasisCents: number;
  /** V3 only — the normal promo-eligible price BEFORE the promo: services + add-ons − service
   * discount (travel excluded). Present on every V3 contract, promo or not. */
  promoEligibleBaseCents?: number | undefined;
  /** The upfront obligation (== Booking.financials.depositCents). V2: pre-promo. V3: computed
   * from the discounted basis. */
  requiredUpfrontCents: number;
  /** V2: discount off the upfront charge. V3: discount off the booking price
   * (`promoEligibleBaseCents − eligibleBasisCents`). */
  promoDiscountCents: number;
  /** What is actually charged online now (== PaymentAttempt.expectedAmountCents when > 0). */
  onlineChargeCents: number;
  travelFeeCents: number;
  /** Package purchase only — the bundle price snapshot the FIRST basis was taken from. */
  packageBundlePriceCents?: number | undefined;
  /** Booking.financials.totalCents at classification time — pricing snapshot correlation. */
  bookingTotalCents: number;
  upfrontLedgerType: UpfrontLedgerType;
  /** V3 only — present exactly when a promo was applied. */
  promo?: FinancialContractPromo | undefined;
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

const isCents = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Exact integer-cent invariants for one contract — the single definition used by the embedded
 * schema hook (every claim/Booking write) and by tests. Returns the first violated rule, or
 * undefined when the contract is internally consistent.
 */
export const findFinancialContractInvariantViolation = (
  contract: FinancialContract,
): string | undefined => {
  if (contract.requiredUpfrontCents > contract.bookingTotalCents) {
    return "requiredUpfrontCents cannot exceed bookingTotalCents";
  }
  if (contract.onlineChargeCents > contract.requiredUpfrontCents) {
    return "onlineChargeCents cannot exceed requiredUpfrontCents";
  }
  if ((contract.classification === "FIRST") !== (contract.upfrontLedgerType === "PLATFORM_FEE")) {
    return "A FIRST contract is always PLATFORM_FEE-owned; RETURNING is DEPOSIT-owned";
  }
  if (
    contract.classification === "FIRST" &&
    contract.requiredUpfrontCents > contract.eligibleBasisCents
  ) {
    return "A FIRST upfront can never exceed its eligible basis";
  }
  if (
    (contract.productKind === "PACKAGE_PURCHASE") !==
    (contract.packageBundlePriceCents !== undefined)
  ) {
    return "packageBundlePriceCents is required exactly for a PACKAGE_PURCHASE contract";
  }

  if (contract.version === FINANCIAL_CONTRACT_V2) {
    if (contract.promoEligibleBaseCents !== undefined || contract.promo !== undefined) {
      return "A V2 contract never carries P2 promo terms";
    }
    if (
      contract.onlineChargeCents + contract.promoDiscountCents !==
      contract.requiredUpfrontCents
    ) {
      return "onlineChargeCents + promoDiscountCents must equal requiredUpfrontCents";
    }
    return undefined;
  }

  // V3 — P2 normal booking: the promo reduces the price BEFORE the upfront is computed.
  if (contract.productKind !== "NORMAL_BOOKING") {
    return "A V3 contract is a NORMAL_BOOKING contract";
  }
  if (!isCents(contract.promoEligibleBaseCents)) {
    return "promoEligibleBaseCents is required on a V3 contract";
  }
  if (
    !isCents(contract.promoDiscountCents) ||
    contract.promoDiscountCents > contract.promoEligibleBaseCents
  ) {
    return "promoDiscountCents must be within [0, promoEligibleBaseCents]";
  }
  if (
    contract.eligibleBasisCents !==
    contract.promoEligibleBaseCents - contract.promoDiscountCents
  ) {
    return "eligibleBasisCents must equal promoEligibleBaseCents - promoDiscountCents";
  }
  if (contract.onlineChargeCents !== contract.requiredUpfrontCents) {
    return "onlineChargeCents must equal requiredUpfrontCents";
  }
  if (contract.bookingTotalCents !== contract.eligibleBasisCents + contract.travelFeeCents) {
    return "bookingTotalCents must equal eligibleBasisCents + travelFeeCents";
  }
  if (!contract.promo && contract.promoDiscountCents !== 0) {
    return "A promo discount requires a frozen promo identity";
  }
  if (contract.promo && contract.promo.fundingOwner !== "BUSINESS") {
    return "A V3 promo is Business-funded";
  }
  return undefined;
};

/** Immutable-field comparison for a resumed logical operation. Returns the first mismatching
 * field name, or undefined when the two contracts describe the same money terms AND (V3) the
 * same promo identity — an equal discount from a different/edited code is still a mismatch. */
export const findFinancialContractMismatch = (
  existing: FinancialContract,
  candidate: FinancialContract,
): string | undefined => {
  const comparisons: Array<[string, unknown, unknown]> = [
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
    [
      "promoEligibleBaseCents",
      existing.promoEligibleBaseCents ?? null,
      candidate.promoEligibleBaseCents ?? null,
    ],
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
    ["promo", Boolean(existing.promo), Boolean(candidate.promo)],
    ["promo.promoId", promoField(existing, "promoId"), promoField(candidate, "promoId")],
    [
      "promo.normalizedCode",
      promoField(existing, "normalizedCode"),
      promoField(candidate, "normalizedCode"),
    ],
    ["promo.type", promoField(existing, "type"), promoField(candidate, "type")],
    ["promo.value", promoField(existing, "value"), promoField(candidate, "value")],
    [
      "promo.fundingOwner",
      promoField(existing, "fundingOwner"),
      promoField(candidate, "fundingOwner"),
    ],
  ];
  return comparisons.find(([, left, right]) => left !== right)?.[0];
};

const promoField = (
  contract: FinancialContract,
  field: keyof FinancialContractPromo,
): string | number | null => {
  const value = contract.promo?.[field];
  if (value === undefined) return null;
  return typeof value === "number" ? value : String(value);
};
