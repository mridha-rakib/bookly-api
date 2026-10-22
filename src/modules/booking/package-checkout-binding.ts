import { createHash } from "node:crypto";
import { Types } from "mongoose";
import { z } from "zod";
import { purchasedAcceptanceEvidenceSchema } from "../package-progress/purchased-package-contract.js";
import {
  type PackageCheckoutQuote,
  packageCheckoutQuoteSchema,
} from "./package-checkout-contract.js";

/** Canonical content digest, NOT a signature, bearer token or consent authority. */
const canonical = (value: unknown): unknown => {
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
};
export const hashPackageCheckoutQuote = (input: unknown): string => {
  const quote = packageCheckoutQuoteSchema.parse(input);
  return createHash("sha256")
    .update(JSON.stringify(canonical(quote)))
    .digest("hex");
};
export const packageCheckoutEnvelopeSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("SHA256"),
    payload: packageCheckoutQuoteSchema,
    termsHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      if (hashPackageCheckoutQuote(value.payload) !== value.termsHash)
        ctx.addIssue({ code: "custom", message: "Checkout content hash mismatch" });
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid checkout payload" });
    }
  })
  .readonly();

export const bindPackageCheckoutQuote = (input: unknown) => {
  const payload = packageCheckoutQuoteSchema.parse(input);
  return packageCheckoutEnvelopeSchema.parse({
    version: 1,
    algorithm: "SHA256",
    payload,
    termsHash: hashPackageCheckoutQuote(payload),
  });
};

/** A retry may refresh only read-observation times, never contract facts. P3-B must
 * retrieve retained server data and perform these re-reads; do not trust a posted quote.
 * No store/in-memory acceptance registry or competing payment idempotency system exists here.
 */
export const assertPackageCheckoutCurrent = (
  retainedInput: unknown,
  freshInput: unknown,
  now: Date,
): void => {
  const retained = packageCheckoutEnvelopeSchema.parse(retainedInput);
  const fresh = packageCheckoutEnvelopeSchema.parse(freshInput);
  if (
    !Number.isFinite(now.getTime()) ||
    now < retained.payload.issuedAt ||
    now >= retained.payload.expiresAt ||
    fresh.payload.appointments.some((row) => row.startAt <= now || row.availabilityCheckedAt > now)
  )
    throw new Error("Checkout quote/schedule expired");
  const normalized: PackageCheckoutQuote = {
    ...fresh.payload,
    appointments: fresh.payload.appointments.map((row) => {
      const old = retained.payload.appointments.find((old) => old.bookingId.equals(row.bookingId));
      if (!old || row.availabilityCheckedAt < old.availabilityCheckedAt)
        throw new Error("Checkout observation is stale");
      return { ...row, availabilityCheckedAt: old.availabilityCheckedAt };
    }),
  };
  if (hashPackageCheckoutQuote(normalized) !== retained.termsHash)
    throw new Error("Checkout facts changed; reprice and reaccept");
};

/** Consistency check over externally retained evidence, NEVER a consent constructor.
 * Caller still owes authenticated session verification, retained exact payload/template,
 * durable acceptance CAS and canonical P3-B claim/payment authority. Returns no success token.
 */
export const assertPackageCheckoutAcceptance = (input: {
  retainedQuote: unknown;
  freshQuote: unknown;
  retainedEvidence: unknown;
  authenticatedActor: { userId: Types.ObjectId; role: "CUSTOMER" };
  now: Date;
}): void => {
  const retained = packageCheckoutEnvelopeSchema.parse(input.retainedQuote);
  const quote = retained.payload;
  assertPackageCheckoutCurrent(input.retainedQuote, input.freshQuote, input.now);
  const evidence = purchasedAcceptanceEvidenceSchema.parse(input.retainedEvidence);
  if (
    input.authenticatedActor.role !== "CUSTOMER" ||
    !input.authenticatedActor.userId.equals(quote.customerUserId) ||
    evidence.scope !== "PURCHASE"
  )
    throw new Error("Customer purchase acceptance required");
  for (const key of [
    "quoteId",
    "batchId",
    "packageProgressId",
    "businessId",
    "customerUserId",
    "actorUserId",
    "packageId",
  ] as const)
    if (!evidence[key].equals(quote[key])) throw new Error(`Checkout acceptance ${key} mismatch`);
  if (
    evidence.contractVersion !== quote.version ||
    evidence.packageRevision !== quote.definitionRevision ||
    evidence.acceptedTermsHash !== retained.termsHash ||
    evidence.acceptedAt < quote.issuedAt ||
    evidence.acceptedAt >= quote.expiresAt ||
    evidence.acceptedAt > input.now ||
    evidence.items.length !== quote.items.length ||
    quote.items.some(
      (item) =>
        !evidence.items.some(
          (accepted) =>
            accepted.packageItemId.equals(item.packageItemId) &&
            accepted.definitionItemId.equals(item.definitionItemId) &&
            accepted.serviceId.equals(item.serviceId),
        ),
    )
  )
    throw new Error("Checkout acceptance payload/membership/time mismatch");
};
