import { Document, Schema } from "mongoose";
import { z } from "zod";
import type { ServiceDocument } from "../services/service.model.js";

/** Group v1 denotes a PER_PERSON Service, one credit and one seat. Absence preserves
 * historical FIXED semantics. Never a posted capacity or an activation grant. */
export const packageGroupSeatSchema = z
  .object({
    version: z.literal(1),
    unit: z.literal("ONE_SEAT"),
    credits: z.literal(1),
    partySize: z.literal(1),
    capacityMax: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type PackageGroupSeat = z.infer<typeof packageGroupSeatSchema>;
/** Model subdocuments retain the same strict contract as detached quote values. */
export const readPackageGroupSeat = (value: PackageGroupSeat): PackageGroupSeat =>
  packageGroupSeatSchema.parse(value instanceof Document ? value.toObject() : value);
export const packageGroupSeatMongooseSchema = new Schema<PackageGroupSeat>(
  {
    version: { type: Number, required: true, enum: [1] },
    unit: { type: String, required: true, enum: ["ONE_SEAT"] },
    credits: { type: Number, required: true, enum: [1] },
    partySize: { type: Number, required: true, enum: [1] },
    capacityMax: {
      type: Number,
      required: true,
      min: 2,
      max: Number.MAX_SAFE_INTEGER,
      validate: Number.isSafeInteger,
    },
  },
  { _id: false, strict: "throw" },
);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const fixed = z.object({
  priceCents: count,
  durationMin: count.min(1),
  bookingIntervalMin: count.min(1).optional(),
  bufferAfterMin: count.optional(),
  processingTimeMin: count.optional(),
  discountPercent: z.number().min(0).max(100).optional(),
});
const group = z.object({
  ratePerPersonCents: count,
  minPersons: z.literal(1),
  maxPersons: count.min(2),
  durationMin: count.min(1),
  bookingIntervalMin: count.min(1).optional(),
  bufferAfterMin: count.optional(),
});
type Source = Pick<
  ServiceDocument,
  "isPackageDeal" | "pricingMode" | "fixedPricing" | "perPersonPricing"
>;
/** PER_PERSON is shared-capacity only when one person is independently admissible. */
export function resolvePackageServiceEntitlement(service: Source) {
  if (service.isPackageDeal) return undefined;
  if (service.pricingMode === "FIXED") {
    const parsed = fixed.safeParse(service.fixedPricing);
    if (!parsed.success) return undefined;
    return { pricingMode: "FIXED" as const, ...parsed.data, group: undefined };
  }
  if (service.pricingMode === "PER_PERSON") {
    const parsed = group.safeParse(service.perPersonPricing);
    if (!parsed.success) return undefined;
    return {
      pricingMode: "PER_PERSON" as const,
      ...parsed.data,
      processingTimeMin: 0,
      group: packageGroupSeatSchema.parse({
        version: 1,
        unit: "ONE_SEAT",
        credits: 1,
        partySize: 1,
        capacityMax: parsed.data.maxPersons,
      }),
    };
  }
  return undefined;
}
