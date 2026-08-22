import { z } from "zod";

import { businessIdParamsSchema } from "../business/business.schema.js";
import {
  CANCELLATION_PERCENTAGE_MAX,
  CANCELLATION_PERCENTAGE_MIN,
  cancellationFeeModes,
  cancellationTiers,
} from "./business-cancellation-policy.model.js";

export { businessIdParamsSchema as cancellationPolicyParamsSchema };

const percentageSchema = z
  .number()
  .int()
  .min(CANCELLATION_PERCENTAGE_MIN, `Percentage must be at least ${CANCELLATION_PERCENTAGE_MIN}`)
  .max(CANCELLATION_PERCENTAGE_MAX, `Percentage must be at most ${CANCELLATION_PERCENTAGE_MAX}`);

const cancellationTierRuleSchema = z
  .object({
    tier: z.enum(cancellationTiers),
    mode: z.enum(cancellationFeeModes),
    percentage: percentageSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "FREE" && value.percentage !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["percentage"],
        message: "A FREE cancellation window must not have a percentage",
      });
    }

    if (value.mode === "PERCENTAGE" && value.percentage === undefined) {
      context.addIssue({
        code: "custom",
        path: ["percentage"],
        message: "A PERCENTAGE cancellation window requires a percentage",
      });
    }
  });

export const putCancellationPolicyBodySchema = z
  .object({
    // Exactly one rule per window, all five required — mirrors the fixed five-row Settings
    // UI, which never lets an owner omit or duplicate a window.
    tiers: z.array(cancellationTierRuleSchema).length(cancellationTiers.length),
    noShowPercentage: percentageSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();

    for (const [index, rule] of value.tiers.entries()) {
      if (seen.has(rule.tier)) {
        context.addIssue({
          code: "custom",
          path: ["tiers", index, "tier"],
          message: `Duplicate cancellation rule for ${rule.tier} — only one rule per window is allowed`,
        });
      }
      seen.add(rule.tier);
    }

    const missing = cancellationTiers.filter((tier) => !seen.has(tier));
    if (missing.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["tiers"],
        message: `Missing a rule for: ${missing.join(", ")}`,
      });
    }
  });

export type CancellationPolicyParams = z.infer<typeof businessIdParamsSchema>;
export type PutCancellationPolicyBody = z.infer<typeof putCancellationPolicyBodySchema>;
