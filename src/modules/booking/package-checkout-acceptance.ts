import { Types } from "mongoose";
import { z } from "zod";
import { purchasedAcceptanceEvidenceSchema } from "../package-progress/purchased-package-contract.js";
import {
  assertPackageDisclosureMatches,
  PACKAGE_DISCLOSURE_TEMPLATE_ID,
  packageCheckoutDisclosureSnapshotSchema,
} from "./package-checkout-disclosure.js";
import { packageCheckoutRetentionSchema } from "./package-checkout-retention.js";

const id = z.custom<Types.ObjectId>((value) => value instanceof Types.ObjectId);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const packageCheckoutAffirmativeActionSchema = z
  .object({
    version: z.literal(1),
    action: z.literal("ACCEPT_PACKAGE_CHECKOUT_TERMS"),
    eventId: z.uuid(),
    presentationId: id,
    challenge: z.string().regex(/^[a-f0-9]{64}$/),
    templateVersion: z.literal(1),
    quoteHash: hash,
    disclosureHash: hash,
  })
  .strict();
export const packageCheckoutPresentationSchema = z
  .object({
    version: z.literal(1),
    presentationId: id,
    sessionFamilyId: z.string().min(1),
    customerUserId: id,
    presentedAt: z.date(),
    challenge: z.string().regex(/^[a-f0-9]{64}$/),
    disclosure: packageCheckoutDisclosureSnapshotSchema,
  })
  .strict();
export const packageCheckoutAcceptedSchema = z
  .object({
    version: z.literal(1),
    state: z.literal("ACCEPTED_IMMUTABLE"),
    event: packageCheckoutAffirmativeActionSchema,
    sessionFamilyId: z.string().min(1),
    evidence: purchasedAcceptanceEvidenceSchema,
    // P2 v1 acceptedTermsHash is the quote digest; disclosureHash is a distinct digest.
    disclosurePayloadId: id,
    disclosureHash: hash,
  })
  .strict();
export type PackageCheckoutPresentation = z.output<typeof packageCheckoutPresentationSchema>;
export type PackageCheckoutAccepted = z.output<typeof packageCheckoutAcceptedSchema>;
export type PackageCheckoutAffirmativeAction = z.output<
  typeof packageCheckoutAffirmativeActionSchema
>;

export const assertPackagePresentation = (retainedInput: unknown, input: unknown) => {
  const retained = packageCheckoutRetentionSchema.parse(retainedInput);
  const presentation = packageCheckoutPresentationSchema.parse(input);
  const q = retained.quote.payload;
  assertPackageDisclosureMatches(retained, presentation.disclosure);
  if (
    !presentation.customerUserId.equals(q.customerUserId) ||
    presentation.presentedAt < q.issuedAt ||
    presentation.presentedAt >= q.expiresAt
  )
    throw new Error("Presentation ownership/window mismatch");
  return presentation;
};
export const assertPackageAccepted = (
  retainedInput: unknown,
  presentationInput: unknown,
  input: unknown,
) => {
  const retained = packageCheckoutRetentionSchema.parse(retainedInput);
  const p = assertPackagePresentation(retained, presentationInput);
  const accepted = packageCheckoutAcceptedSchema.parse(input);
  const q = retained.quote.payload,
    e = accepted.evidence,
    action = accepted.event;
  if (
    e.scope !== "PURCHASE" ||
    e.templateId.toHexString() !== PACKAGE_DISCLOSURE_TEMPLATE_ID ||
    e.templateVersion !== p.disclosure.content.templateVersion ||
    !e.acceptedTermsPayloadId.equals(q.quoteId) ||
    !accepted.disclosurePayloadId.equals(p.disclosure.content.payloadId) ||
    e.acceptedTermsHash !== retained.quote.termsHash ||
    accepted.disclosureHash !== p.disclosure.contentHash ||
    accepted.sessionFamilyId !== p.sessionFamilyId ||
    !action.presentationId.equals(p.presentationId) ||
    action.challenge !== p.challenge ||
    action.quoteHash !== retained.quote.termsHash ||
    action.disclosureHash !== p.disclosure.contentHash ||
    e.acceptedAt < p.presentedAt ||
    e.acceptedAt >= q.expiresAt ||
    (q.validity.mode === "FINITE" &&
      (e.acceptedAt < q.validity.activationNotBefore ||
        e.acceptedAt >= q.validity.activationNotAfterExclusive))
  )
    throw new Error("Accepted disclosure/event mismatch");
  for (const key of [
    "quoteId",
    "batchId",
    "packageProgressId",
    "businessId",
    "customerUserId",
    "actorUserId",
    "packageId",
  ] as const)
    if (!e[key].equals(q[key])) throw new Error("Accepted ownership mismatch");
  if (
    e.packageRevision !== q.definitionRevision ||
    e.items.length !== q.items.length ||
    q.items.some(
      (item) =>
        !e.items.some(
          (row) =>
            row.packageItemId.equals(item.packageItemId) &&
            row.definitionItemId.equals(item.definitionItemId) &&
            row.serviceId.equals(item.serviceId),
        ),
    )
  )
    throw new Error("Accepted membership mismatch");
  return accepted;
};
