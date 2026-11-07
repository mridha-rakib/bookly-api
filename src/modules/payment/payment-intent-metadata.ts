/**
 * PaymentIntent metadata is provider-side correlation data, not a second financial ledger.
 * Keep it flat, immutable, and deliberately small: Stripe allows at most 50 key/value pairs,
 * keys up to 40 characters and values up to 500 characters. Object ids and integer cents fit
 * comfortably; customer PII and serialised objects do not belong here.
 */
export const BOOKLY_PAYMENT_METADATA_VERSION = "c3-prep-v1";

export type PaymentIntentPurpose =
  | "BOOKING_DEPOSIT"
  | "PACKAGE_PURCHASE"
  | "PACKAGE_SESSION_EXTRAS"
  | "CANCELLATION_FEE"
  | "NO_SHOW_FEE";

export type PaymentTaxMode = "PRE_ACTIVATION" | "VAT_INCLUSIVE";

/** Whether `taxCents` is a real Stripe Tax result. Derived, never caller-asserted: CALCULATED only
 * with a Stripe `taxCalculationId`. NOT_CALCULATED means no calculation exists, so `taxCents` must
 * be 0 and is NOT a zero-VAT determination. PIs created before this field carry neither. */
export type PaymentTaxStatus = "CALCULATED" | "NOT_CALCULATED";

/** Why no calculation exists for a positive online charge. */
export type PaymentTaxNotCalculatedReason =
  /** Cancellation/no-show fees are Business-owned revenue (finance-ownership.ts); Bookly's Stripe
   * Tax registration does not establish the Business's VAT position, and no per-Business tax
   * context exists. */
  | "BUSINESS_SUPPLY_TAX_CONTEXT_UNAVAILABLE"
  /** P0.5 fee reasons from the Business's own tax settings (business-tax-settings.ts). */
  | "BUSINESS_TAX_SETTINGS_NOT_CONFIGURED"
  | "BUSINESS_TAX_ACCOUNT_UNAVAILABLE"
  | "BUSINESS_DECLARED_NO_VAT_REGISTRATION"
  /** The informational Stripe Tax calculation could not be obtained for this charge. */
  | "TAX_CALCULATION_UNAVAILABLE"
  /** No tax service is composed (isolated test/legacy construction only). */
  | "TAX_SERVICE_NOT_CONFIGURED";

export type PaymentIntentMetadataInput = {
  bookingId: string;
  businessId: string;
  businessClientId: string;
  purpose: PaymentIntentPurpose;
  preTaxChargeCents: number;
  /** The Stripe-calculated amount is retained for correlation even while the live PI remains
   * pre-tax. VAT_INCLUSIVE is the only mode whose PI amount may include this amount. */
  taxCents: number;
  chargedAmountCents: number;
  taxCalculationId?: string | undefined;
  taxMode: PaymentTaxMode;
  /** Recorded only when no `taxCalculationId` is supplied. */
  taxNotCalculatedReason?: PaymentTaxNotCalculatedReason | undefined;
  /** P1 — additive, optional Financial Contract (V2/V3) correlation. `businessClientId` above is the
   * customer↔business relationship correlation. */
  financialContract?:
    | {
        version: 2 | 3;
        classification: "FIRST" | "RETURNING";
        productKind: "NORMAL_BOOKING" | "PACKAGE_PURCHASE";
      }
    | undefined;
};

export type ParsedPaymentIntentMetadata = PaymentIntentMetadataInput & {
  version: typeof BOOKLY_PAYMENT_METADATA_VERSION;
  /** Absent on PIs created before tax status was recorded (unknown, not zero). */
  taxStatus?: PaymentTaxStatus;
  /** VAT actually included in the charged amount: always 0 in PRE_ACTIVATION. */
  taxCollectedCents?: number;
};

const notCalculatedReasons = new Set<PaymentTaxNotCalculatedReason>([
  "BUSINESS_SUPPLY_TAX_CONTEXT_UNAVAILABLE",
  "BUSINESS_TAX_SETTINGS_NOT_CONFIGURED",
  "BUSINESS_TAX_ACCOUNT_UNAVAILABLE",
  "BUSINESS_DECLARED_NO_VAT_REGISTRATION",
  "TAX_CALCULATION_UNAVAILABLE",
  "TAX_SERVICE_NOT_CONFIGURED",
]);

const purposes = new Set<PaymentIntentPurpose>([
  "BOOKING_DEPOSIT",
  "PACKAGE_PURCHASE",
  "PACKAGE_SESSION_EXTRAS",
  "CANCELLATION_FEE",
  "NO_SHOW_FEE",
]);

const objectIdPattern = /^[a-f\d]{24}$/i;
const centsPattern = /^(0|[1-9]\d*)$/;

const requireObjectId = (name: string, value: string): void => {
  if (!objectIdPattern.test(value)) throw new Error(`${name} must be an ObjectId`);
};

const requireCents = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer-cent value`);
  }
};

/** Builds all Bookly PaymentIntent metadata in one place. PRE_ACTIVATION intentionally preserves
 * C2's pre-tax PaymentIntent amount; VAT_INCLUSIVE is reserved for the later atomic activation. */
export const buildPaymentIntentMetadata = (
  input: PaymentIntentMetadataInput,
): Record<string, string> => {
  requireObjectId("bookingId", input.bookingId);
  requireObjectId("businessId", input.businessId);
  requireObjectId("businessClientId", input.businessClientId);
  if (!purposes.has(input.purpose)) throw new Error("Unknown payment purpose");
  requireCents("preTaxChargeCents", input.preTaxChargeCents);
  requireCents("taxCents", input.taxCents);
  requireCents("chargedAmountCents", input.chargedAmountCents);
  if (
    input.taxMode === "VAT_INCLUSIVE" &&
    input.chargedAmountCents !== input.preTaxChargeCents + input.taxCents
  ) {
    throw new Error("VAT-inclusive chargedAmountCents must equal preTaxChargeCents + taxCents");
  }
  if (input.taxMode === "PRE_ACTIVATION" && input.chargedAmountCents !== input.preTaxChargeCents) {
    throw new Error("Pre-activation PaymentIntent amount must remain pre-tax");
  }
  const taxStatus: PaymentTaxStatus = input.taxCalculationId ? "CALCULATED" : "NOT_CALCULATED";
  // A tax amount without a calculation would be invented VAT; VAT can never be collected unknown.
  if (taxStatus === "NOT_CALCULATED" && input.taxCents !== 0)
    throw new Error("taxCents requires a Stripe taxCalculationId");
  if (taxStatus === "NOT_CALCULATED" && input.taxMode === "VAT_INCLUSIVE")
    throw new Error("VAT-inclusive PaymentIntent requires a Stripe taxCalculationId");
  if (taxStatus === "CALCULATED" && input.taxNotCalculatedReason)
    throw new Error("A calculated tax cannot carry a not-calculated reason");

  return {
    booklyPaymentVersion: BOOKLY_PAYMENT_METADATA_VERSION,
    taxMode: input.taxMode,
    bookingId: input.bookingId,
    businessId: input.businessId,
    businessClientId: input.businessClientId,
    purpose: input.purpose,
    preTaxChargeCents: String(input.preTaxChargeCents),
    taxCents: String(input.taxCents),
    chargedAmountCents: String(input.chargedAmountCents),
    ...(input.taxCalculationId ? { taxCalculationId: input.taxCalculationId } : {}),
    taxStatus,
    taxCollectedCents: String(input.taxMode === "VAT_INCLUSIVE" ? input.taxCents : 0),
    ...(input.taxNotCalculatedReason
      ? { taxNotCalculatedReason: input.taxNotCalculatedReason }
      : {}),
    ...(input.financialContract
      ? {
          financialContractVersion: String(input.financialContract.version),
          relationshipClassification: input.financialContract.classification,
          productKind: input.financialContract.productKind,
        }
      : {}),
  };
};

/** Returns undefined only for a genuinely legacy/non-Bookly PI. A PI claiming the C3 contract
 * but violating it is an investigation failure; callers must never guess missing ownership. */
export const parsePaymentIntentMetadata = (
  metadata: Record<string, string> | undefined | null,
): ParsedPaymentIntentMetadata | undefined => {
  if (!metadata?.["booklyPaymentVersion"]) return undefined;
  if (metadata["booklyPaymentVersion"] !== BOOKLY_PAYMENT_METADATA_VERSION) {
    throw new Error("Unsupported Bookly PaymentIntent metadata version");
  }

  const required = [
    "taxMode",
    "bookingId",
    "businessId",
    "businessClientId",
    "purpose",
    "preTaxChargeCents",
    "taxCents",
    "chargedAmountCents",
  ] as const;
  for (const key of required) {
    if (!metadata[key]) throw new Error(`Missing required PaymentIntent metadata: ${key}`);
  }

  const taxMode = metadata["taxMode"];
  if (taxMode !== "PRE_ACTIVATION" && taxMode !== "VAT_INCLUSIVE") {
    throw new Error("Unknown PaymentIntent tax mode");
  }
  if (!purposes.has(metadata["purpose"] as PaymentIntentPurpose)) {
    throw new Error("Unknown PaymentIntent purpose");
  }
  requireObjectId("bookingId", metadata["bookingId"] as string);
  requireObjectId("businessId", metadata["businessId"] as string);
  requireObjectId("businessClientId", metadata["businessClientId"] as string);

  const parseCents = (name: "preTaxChargeCents" | "taxCents" | "chargedAmountCents"): number => {
    const raw = metadata[name] as string;
    if (!centsPattern.test(raw)) throw new Error(`${name} must be a non-negative integer string`);
    const value = Number(raw);
    requireCents(name, value);
    return value;
  };
  const preTaxChargeCents = parseCents("preTaxChargeCents");
  const taxCents = parseCents("taxCents");
  const chargedAmountCents = parseCents("chargedAmountCents");
  if (taxMode === "VAT_INCLUSIVE" && chargedAmountCents !== preTaxChargeCents + taxCents) {
    throw new Error("VAT-inclusive PaymentIntent metadata amount invariant failed");
  }
  if (taxMode === "PRE_ACTIVATION" && chargedAmountCents !== preTaxChargeCents) {
    throw new Error("Pre-activation PaymentIntent metadata amount invariant failed");
  }
  // Optional (absent before tax status was recorded); when present it must be self-consistent.
  const taxStatus = metadata["taxStatus"];
  const reason = metadata["taxNotCalculatedReason"];
  const collectedRaw = metadata["taxCollectedCents"];
  if (taxStatus !== undefined) {
    if (taxStatus !== "CALCULATED" && taxStatus !== "NOT_CALCULATED")
      throw new Error("Unknown PaymentIntent tax status");
    if ((taxStatus === "CALCULATED") !== Boolean(metadata["taxCalculationId"]))
      throw new Error("PaymentIntent tax status does not match its tax calculation");
    if (taxStatus === "NOT_CALCULATED" && taxCents !== 0)
      throw new Error("Uncalculated PaymentIntent tax must be zero");
  }
  if (
    reason !== undefined &&
    (taxStatus !== "NOT_CALCULATED" ||
      !notCalculatedReasons.has(reason as PaymentTaxNotCalculatedReason))
  )
    throw new Error("Invalid PaymentIntent tax reason");
  let taxCollectedCents: number | undefined;
  if (collectedRaw !== undefined) {
    if (!centsPattern.test(collectedRaw)) throw new Error("taxCollectedCents is malformed");
    taxCollectedCents = Number(collectedRaw);
    if (taxCollectedCents !== (taxMode === "VAT_INCLUSIVE" ? taxCents : 0))
      throw new Error("PaymentIntent collected tax invariant failed");
  }

  return {
    version: BOOKLY_PAYMENT_METADATA_VERSION,
    taxMode,
    bookingId: metadata["bookingId"] as string,
    businessId: metadata["businessId"] as string,
    businessClientId: metadata["businessClientId"] as string,
    purpose: metadata["purpose"] as PaymentIntentPurpose,
    preTaxChargeCents,
    taxCents,
    chargedAmountCents,
    ...(metadata["taxCalculationId"] ? { taxCalculationId: metadata["taxCalculationId"] } : {}),
    ...(taxStatus ? { taxStatus: taxStatus as PaymentTaxStatus } : {}),
    ...(reason ? { taxNotCalculatedReason: reason as PaymentTaxNotCalculatedReason } : {}),
    ...(taxCollectedCents !== undefined ? { taxCollectedCents } : {}),
  };
};
