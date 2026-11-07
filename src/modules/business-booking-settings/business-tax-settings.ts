import { z } from "zod";

/**
 * Business-declared VAT position. Bookly is Cyprus-only (locked product rule), so the only
 * supported tax jurisdiction is CY. Absence of a stored value means NOT_CONFIGURED.
 */
export type BusinessTaxStatus =
  | "NOT_CONFIGURED"
  | "VAT_REGISTERED"
  | "VAT_EXEMPT"
  | "NOT_VAT_REGISTERED";

export type StoredBusinessTaxSettings = {
  status: Exclude<BusinessTaxStatus, "NOT_CONFIGURED">;
  countryCode: "CY";
  vatNumber?: string | undefined;
  updatedAt: Date;
};

/** Cyprus VAT identification number: "CY", 8 digits, 1 letter. Spaces are ignored. */
const CYPRUS_VAT_NUMBER = /^CY\d{8}[A-Z]$/;

const vatNumberSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, "").toUpperCase())
  .pipe(
    z
      .string()
      .regex(CYPRUS_VAT_NUMBER, "Enter a Cyprus VAT number: CY followed by 8 digits and a letter"),
  );

const countryCodeSchema = z.literal("CY", {
  error: "Bookly currently supports Cyprus (CY) as the only tax country",
});

export const updateBusinessTaxSettingsBodySchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("VAT_REGISTERED"),
      countryCode: countryCodeSchema,
      vatNumber: vatNumberSchema,
    })
    .strict(),
  z
    .object({
      status: z.enum(["VAT_EXEMPT", "NOT_VAT_REGISTERED"]),
      countryCode: countryCodeSchema,
    })
    .strict(),
]);
export type UpdateBusinessTaxSettingsBody = z.infer<typeof updateBusinessTaxSettingsBodySchema>;

/** Why Bookly cannot calculate VAT on this Business's cancellation/no-show fees. */
export type BusinessFeeTaxBlocker =
  /** The Business has not declared its VAT position. */
  | "BUSINESS_TAX_SETTINGS_NOT_CONFIGURED"
  /** VAT registration declared, but no Stripe account holds that registration: every charge runs
   * on Bookly's platform account, whose Stripe Tax registration is Bookly's, not the Business's. */
  | "BUSINESS_TAX_ACCOUNT_UNAVAILABLE"
  /** The Business declares it is exempt or not registered. That is the Business's own
   * declaration, not a Bookly tax determination, so it is recorded as such and not as €0 VAT. */
  | "BUSINESS_DECLARED_NO_VAT_REGISTRATION";

export type BusinessFeeTaxAssessment = {
  calculationEnabled: false;
  blocker: BusinessFeeTaxBlocker;
};

/**
 * The single fee-VAT decision used by Business Settings and by fee PaymentIntents.
 *
 * Calculation is never enabled today: fees are Business revenue (finance-ownership.ts), and the
 * only Stripe Tax context available is Bookly's own registration. A saved VAT number does not
 * give Stripe authority to calculate under the Business's liability. Enabling this requires a
 * Business-owned Stripe tax context (e.g. a connected account with its own registration) plus a
 * legal decision that the fee is a taxable supply.
 */
export function assessBusinessFeeTax(
  settings: StoredBusinessTaxSettings | null | undefined,
): BusinessFeeTaxAssessment {
  if (!settings)
    return { calculationEnabled: false, blocker: "BUSINESS_TAX_SETTINGS_NOT_CONFIGURED" };
  if (settings.status === "VAT_REGISTERED")
    return { calculationEnabled: false, blocker: "BUSINESS_TAX_ACCOUNT_UNAVAILABLE" };
  return { calculationEnabled: false, blocker: "BUSINESS_DECLARED_NO_VAT_REGISTRATION" };
}

/** Setup is complete once the Business has declared a valid position (a registered Business
 * must also hold a valid VAT number). */
export function isBusinessTaxSetupComplete(
  settings: StoredBusinessTaxSettings | null | undefined,
): boolean {
  if (settings?.countryCode !== "CY") return false;
  if (settings.status === "VAT_REGISTERED")
    return Boolean(settings.vatNumber && CYPRUS_VAT_NUMBER.test(settings.vatNumber));
  return true;
}
