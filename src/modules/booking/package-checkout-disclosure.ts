import { DateTime } from "luxon";
import { Types } from "mongoose";
import { z } from "zod";
import { cancellationTiers } from "../business-cancellation-policy/business-cancellation-policy.model.js";
import { PackageCheckoutConflictError } from "./package-checkout.errors.js";
import { hashCanonicalPackageCheckoutContent } from "./package-checkout-binding.js";
import { comparePackageCheckoutIds } from "./package-checkout-contract.js";
import { packageCheckoutRetentionSchema } from "./package-checkout-retention.js";

export const PACKAGE_DISCLOSURE_TEMPLATE_ID = "00000000000000000000b1b1";
const id = z.custom<Types.ObjectId>((value) => value instanceof Types.ObjectId);
export const packageDisclosureProviderSchema = z
  .object({
    staffMembershipId: id,
    displayName: z.string().trim().min(1),
  })
  .strict();
const contentSchema = z
  .object({
    version: z.literal(1),
    templateId: z.literal(PACKAGE_DISCLOSURE_TEMPLATE_ID),
    templateVersion: z.literal(1),
    locale: z.literal("en"),
    payloadId: id,
    quoteId: id,
    batchId: id,
    packageProgressId: id,
    businessId: id,
    customerUserId: id,
    definitionRevision: z.number().int().positive(),
    quoteHash: z.string().regex(/^[a-f0-9]{64}$/),
    providers: z.array(packageDisclosureProviderSchema).min(1),
    renderedTermsSnapshot: z.string().min(1),
  })
  .strict();
export const packageCheckoutDisclosureSnapshotSchema = z
  .object({
    content: contentSchema,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (hashCanonicalPackageCheckoutContent(value.content) !== value.contentHash)
      ctx.addIssue({ code: "custom", message: "Disclosure content hash mismatch" });
  });
export type PackageCheckoutDisclosureSnapshot = z.output<
  typeof packageCheckoutDisclosureSnapshotSchema
>;

const euros = (cents: number) =>
  `EUR ${BigInt(cents) / 100n}.${(BigInt(cents) % 100n).toString().padStart(2, "0")}`;
const windows = {
  MORE_THAN_72_HOURS: "72 hours or more before the appointment",
  BETWEEN_24_AND_72_HOURS: "24 hours to less than 72 hours before the appointment",
  BETWEEN_12_AND_24_HOURS: "12 hours to less than 24 hours before the appointment",
  BETWEEN_2_AND_12_HOURS: "2 hours to less than 12 hours before the appointment",
  UNDER_2_HOURS: "less than 2 hours before the appointment",
};

/** Pure server template. Provider names must come from owned staff/profile reads, never a body.
 * Exact plain text is retained; a future UI must render it as text, not trusted HTML.
 */
export const buildPackageCheckoutDisclosure = (
  input: unknown,
  payloadId: Types.ObjectId,
  providerInput: unknown,
): PackageCheckoutDisclosureSnapshot => {
  const retained = packageCheckoutRetentionSchema.parse(input);
  const q = retained.quote.payload;
  const providers = z
    .array(packageDisclosureProviderSchema)
    .min(1)
    .parse(providerInput)
    .sort((a, b) => comparePackageCheckoutIds(a.staffMembershipId, b.staffMembershipId));
  const selected = new Set(q.appointments.map((row) => row.staffMembershipId.toHexString()));
  if (
    providers.length !== selected.size ||
    new Set(providers.map((row) => row.staffMembershipId.toHexString())).size !== selected.size ||
    providers.some((row) => !selected.has(row.staffMembershipId.toHexString()))
  )
    throw new PackageCheckoutConflictError("Exact selected staff names required");
  const positivePenalties =
    q.penalty.lifetimeCapCents > 0 && q.items.some((row) => row.penaltyBasisCents > 0);
  if (positivePenalties && (!q.policy.cancellation || !q.policy.noShowWindow))
    throw new PackageCheckoutConflictError(
      "Configured cancellation/no-show disclosure required for positive penalties",
    );
  const lines = [
    `Package: ${q.packageName}. Purchased package price: ${euros(q.financials.bundlePriceCents)}.`,
    "Included Services and quantities:",
    ...q.items.map(
      (item) =>
        `${item.serviceName}: ${item.totalSessions} sessions; independent monetary penalty basis per included session ${euros(item.penaltyBasisCents)}. Reference price ${euros(item.referenceUnitPriceCents)} is for comparison, not the penalty basis.`,
    ),
    "Initially selected appointments (each is a separate appointment):",
    ...q.appointments.map((row) => {
      const item = q.items.find((item) => item.packageItemId.equals(row.packageItemId));
      const provider = providers.find((p) => p.staffMembershipId.equals(row.staffMembershipId));
      const local = DateTime.fromJSDate(row.startAt, { zone: q.businessTimezone }).toISO();
      if (!local || !item || !provider)
        throw new PackageCheckoutConflictError("Incomplete appointment disclosure");
      const address =
        row.location.mode === "AT_BUSINESS_LOCATION"
          ? row.location.businessLocation
          : row.location.travelAddress;
      return `${item.serviceName} with ${provider.displayName}: ${local} (${q.businessTimezone}); ${row.location.mode === "AT_BUSINESS_LOCATION" ? "at Business location" : "travel to Customer"}: ${[address.city, address.area, address.streetName, address.streetNumber, address.floorUnit, address.aptRoom].filter(Boolean).join(", ")}; occupied ${row.timing.occupiedDurationMin} minutes. Add-ons: ${row.addons.map((a) => `${a.name} ${euros(a.priceCents)}`).join(", ") || "none"}. Travel: ${euros(row.travelFeeCents)}.`;
    }),
  ];
  if (q.validity.mode === "FOREVER")
    lines.push(
      "Validity: FOREVER. No Package-specific expiry; ordinary scheduling and eligibility rules still apply.",
    );
  else
    lines.push(
      `Validity: FINITE${q.validity.months}. Exactly ${q.validity.months} calendar months from the original successful purchase activation, in ${q.validity.timezone}; later bookings do not restart validity.`,
      `Estimated expiry (not the final purchase expiry): ${q.validity.estimatedExpiresAt.toISOString()}. Guaranteed minimum expiry boundary (not before): ${q.validity.guaranteedNotBeforeExpiry.toISOString()}.`,
      `This quote's purchase activation window: ${q.validity.activationNotBefore.toISOString()} to strictly before ${q.validity.activationNotAfterExclusive.toISOString()}. The final immutable expiry is fixed only at successful activation, using calendar month-day clamp, preserved local time, gap-forward and later-fold rules.`,
      "New booking authorization and the appointment start must both be strictly before expiry. Unbooked unused credits expire. A previously valid scheduled appointment may complete after expiry; the deadline does not require its completion before expiry.",
    );
  lines.push("Cancellation policy:");
  for (const tier of cancellationTiers) {
    const rule = q.policy.cancellation?.tiers.find((rule) => rule.tier === tier);
    lines.push(
      `${windows[tier]}: ${!rule ? "not configured; no rate is inferred" : rule.mode === "FREE" ? "free cancellation; no cancellation monetary fee" : `${rule.percentage}% of the included Service's independent penalty basis, subject to the monetary caps`}.`,
    );
  }
  lines.push(
    "A qualifying late cancellation or no-show may forfeit the included credit PLUS produce a separate monetary penalty. A free cancellation does not create a monetary penalty. Credit handling and monetary assessment are separate consequences.",
    "Business cancellation does not impose a Customer cancellation/no-show penalty. A restored credit remains subject to the original validity; after the deadline it is expired. Cancellation does not restart Package validity.",
    `Business no-show percentage: ${q.policy.cancellation ? `${q.policy.cancellation.noShowPercentage}% of the independent included-session penalty basis` : "not configured; no percentage is inferred"}.`,
    q.policy.noShowWindow
      ? `No-show eligibility timing for ${q.policy.noShowWindow.categoryKey}: opens ${q.policy.noShowWindow.opensAfterMinutes} minutes after appointment start; closes ${q.policy.noShowWindow.closesAfterMinutes} minutes after start. Resolution window: ${q.policy.noShowResolutionMinutes} minutes. Timing alone does not establish that a no-show occurred.`
      : "No-show category timing is not configured; no timing is inferred.",
    `Maximum additional monetary charge per appointment: ${euros(q.penalty.appointmentCapCents)}. Purchased Package lifetime monetary cap: ${euros(q.penalty.lifetimeCapCents)} (the smaller of EUR 100.00 and half the sold Package price, rounded down in cents).`,
    `The FIRST Package deposit does not offset a monetary penalty. Only the included-session basis applies, not reference prices, add-ons or travel. ${q.penalty.lifetimeCapCents === 0 ? "The evaluated lifetime cap is EUR 0.00: no Package monetary penalty can be collected." : "An applicable separately assessed monetary penalty may be collected using the saved card, subject to the appointment and remaining lifetime caps."}`,
    "A possible contractual monetary assessment is not an actual provider charge. Credit forfeiture is not payment. Package expiry alone never charges money. These prospective terms do not authorize monetary collection for historical/legacy Packages.",
    `Normal payment estimate: ${q.financials.classification}; estimated required Package upfront deposit ${euros(q.financials.requiredUpfrontCents)}. Final classification and required payment must be confirmed before purchase; changed terms require a new disclosure and acceptance.`,
    `Initial add-on dues: ${euros(q.financials.addonsCents)}. Initial travel dues: ${euros(q.financials.travelCents)}. Normal total: ${euros(q.financials.normalTotalCents)}. Estimated remaining manual venue dues after the required upfront: ${euros(q.financials.manualVenueDuesCents)}. These normal outstanding dues are not automatically collected from the saved card and are separate from possible penalties.`,
    "Accepting these terms is not payment, slot reservation or successful Package purchase. Saved-card setup and ordinary login do not establish acceptance.",
  );
  const content = contentSchema.parse({
    version: 1,
    templateId: PACKAGE_DISCLOSURE_TEMPLATE_ID,
    templateVersion: 1,
    locale: "en",
    payloadId,
    quoteId: q.quoteId,
    batchId: q.batchId,
    packageProgressId: q.packageProgressId,
    businessId: q.businessId,
    customerUserId: q.customerUserId,
    definitionRevision: q.definitionRevision,
    quoteHash: retained.quote.termsHash,
    providers,
    renderedTermsSnapshot: lines.join("\n\n"),
  });
  return packageCheckoutDisclosureSnapshotSchema.parse({
    content,
    contentHash: hashCanonicalPackageCheckoutContent(content),
  });
};

export const assertPackageDisclosureMatches = (retained: unknown, input: unknown) => {
  const snapshot = packageCheckoutDisclosureSnapshotSchema.parse(input);
  const rebuilt = buildPackageCheckoutDisclosure(
    retained,
    snapshot.content.payloadId,
    snapshot.content.providers,
  );
  if (rebuilt.contentHash !== snapshot.contentHash)
    throw new PackageCheckoutConflictError("Disclosure does not match retained terms/template");
  return snapshot;
};
