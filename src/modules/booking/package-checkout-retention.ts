import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { packageCheckoutEnvelopeSchema } from "./package-checkout-binding.js";
import {
  comparePackageCheckoutIds,
  packageCheckoutIntentSchema,
  packageCheckoutSeedSchema,
} from "./package-checkout-contract.js";

/** Selection order and add-on order are not operation identity. All selected facts are. */
export const normalizePackageCheckoutIntent = (input: unknown) => {
  const intent = packageCheckoutIntentSchema.parse(input);
  return {
    ...intent,
    selections: intent.selections
      .map((row) => ({ ...row, addonIds: [...row.addonIds].sort(comparePackageCheckoutIds) }))
      .sort((a, b) => comparePackageCheckoutIds(a.selectionId, b.selectionId)),
  };
};

/** Stored on the canonical creation claim, never a payment or acceptance store.
 * The P3-A payload is retained verbatim (including its original unretained-state label)
 * so its content hash is stable. Only this outer record describes durable retention.
 * There is deliberately no accepted state, evidence setter or activation command.
 */
export const packageCheckoutRetentionSchema = z
  .object({
    version: z.literal(1),
    state: z.literal("INTERNAL_RETAINED_NOT_ACCEPTED"),
    seed: packageCheckoutSeedSchema,
    intent: packageCheckoutIntentSchema,
    quote: packageCheckoutEnvelopeSchema,
  })
  .strict()
  .superRefine(({ seed, intent, quote: { payload } }, ctx) => {
    const fail = () => ctx.addIssue({ code: "custom", message: "Retained checkout mismatch" });
    for (const values of [
      seed.items.map((row) => row.definitionItemId),
      seed.items.map((row) => row.packageItemId),
      seed.appointments.map((row) => row.selectionId),
      seed.appointments.map((row) => row.bookingId),
      intent.selections.map((row) => row.selectionId),
    ])
      if (new Set(values.map((value) => value.toHexString())).size !== values.length) fail();
    for (const key of [
      "quoteId",
      "batchId",
      "packageProgressId",
      "businessId",
      "customerUserId",
      "actorUserId",
    ] as const)
      if (!seed[key].equals(payload[key])) fail();
    if (
      seed.idempotencyKey !== payload.idempotencyKey ||
      seed.issuedAt.getTime() !== payload.issuedAt.getTime() ||
      seed.expiresAt.getTime() !== payload.expiresAt.getTime() ||
      !intent.packageId.equals(payload.packageId) ||
      intent.expectedRevision !== payload.definitionRevision ||
      seed.items.length !== payload.items.length ||
      seed.appointments.length !== payload.appointments.length ||
      intent.selections.length !== payload.appointments.length
    )
      fail();
    for (const item of seed.items)
      if (
        payload.items.filter(
          (row) =>
            row.definitionItemId.equals(item.definitionItemId) &&
            row.packageItemId.equals(item.packageItemId),
        ).length !== 1
      )
        fail();
    for (const mapping of seed.appointments)
      if (
        payload.appointments.filter(
          (row) =>
            row.selectionId.equals(mapping.selectionId) && row.bookingId.equals(mapping.bookingId),
        ).length !== 1
      )
        fail();
    for (const selection of intent.selections) {
      const row = payload.appointments.find((row) => row.selectionId.equals(selection.selectionId));
      if (
        !row?.definitionItemId.equals(selection.definitionItemId) ||
        !row.serviceId.equals(selection.serviceId) ||
        !row.staffMembershipId.equals(selection.staffMembershipId) ||
        row.startAt.getTime() !== selection.startAt.getTime() ||
        !isDeepStrictEqual(
          [...selection.addonIds].sort(comparePackageCheckoutIds),
          row.addons.map((addon) => addon.addonId).sort(comparePackageCheckoutIds),
        ) ||
        !isDeepStrictEqual(
          selection.travelAddress,
          row.location.mode === "TRAVEL_TO_CUSTOMER" ? row.location.travelAddress : undefined,
        )
      )
        fail();
    }
    if (
      payload.validity.mode === "FINITE" &&
      !seed.temporalProofRef?.equals(payload.validity.guaranteeProofRef)
    )
      fail();
  });

export type PackageCheckoutRetention = z.output<typeof packageCheckoutRetentionSchema>;
