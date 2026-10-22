import { Schema, Types } from "mongoose";
import { z } from "zod";
import { packageProgressV2InputSchema } from "../package-progress/package-progress-v2.rules.js";

const id = z.custom<Types.ObjectId>(
  (value) => value instanceof Types.ObjectId,
  "Expected ObjectId",
);
const common = {
  version: z.literal(1),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  selectedItemId: id,
};
export const packageRequestBindingSchema = z
  .discriminatedUnion("operation", [
    z
      .object({
        ...common,
        operation: z.literal("PURCHASE"),
        packageId: id,
        acceptedPurchaseSnapshot: packageProgressV2InputSchema.optional(),
      })
      .strict(),
    z.object({ ...common, operation: z.literal("REDEMPTION"), packageProgressId: id }).strict(),
  ])
  .superRefine((binding, context) => {
    if (
      binding.operation === "PURCHASE" &&
      binding.acceptedPurchaseSnapshot &&
      (!binding.packageId.equals(binding.acceptedPurchaseSnapshot.packageId) ||
        !binding.acceptedPurchaseSnapshot.items.some((item) =>
          item.definitionItemId.equals(binding.selectedItemId),
        ))
    ) {
      context.addIssue({
        code: "custom",
        message: "Accepted purchase does not match selected definition/item",
      });
    }
  });
export type PackageRequestBinding = z.infer<typeof packageRequestBindingSchema>;
export const packageRequestBindingMongooseSchema = new Schema(
  {
    version: { type: Number, enum: [1], required: true },
    operation: { type: String, enum: ["PURCHASE", "REDEMPTION"], required: true },
    requestHash: { type: String, required: true },
    selectedItemId: { type: Schema.Types.ObjectId, required: true },
    packageId: Schema.Types.ObjectId,
    packageProgressId: Schema.Types.ObjectId,
    acceptedPurchaseSnapshot: Schema.Types.Mixed,
  },
  { _id: false, strict: "throw" },
);
