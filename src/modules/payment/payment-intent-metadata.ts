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
};

export type ParsedPaymentIntentMetadata = PaymentIntentMetadataInput & {
  version: typeof BOOKLY_PAYMENT_METADATA_VERSION;
};

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
  };
};
