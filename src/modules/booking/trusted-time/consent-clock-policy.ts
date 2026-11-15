import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { consentHostPolicySchema } from "./host-policy.js";
import type { QualifiedConsentHost } from "./qualified-host.js";

/** The five trusted-clock limits. They are required approved inputs: no field has a
 * default, a fallback or an environment source. The structural bounds come from the
 * existing P4H schema and are NOT recommended trust limits. */
export const CONSENT_CLOCK_LIMITS = [
  "maxAcquireMs",
  "maxSampleAgeMs",
  "maxErrorMs",
  "maxDriftPpm",
  "minRemainingMs",
] as const;
export type ConsentClockLimit = (typeof CONSENT_CLOCK_LIMITS)[number];

const reference = z.string().min(1).max(256);

/** An Owner-approved numerical policy record. `approvalReference` names the signed decision
 * (with its target measurements); the record itself grants nothing and qualifies no host. */
export const approvedConsentClockPolicySchema = consentHostPolicySchema
  .pick({
    maxAcquireMs: true,
    maxSampleAgeMs: true,
    maxErrorMs: true,
    maxDriftPpm: true,
    minRemainingMs: true,
  })
  .extend({ version: z.literal(1), approvalReference: reference })
  .strict();
export type ApprovedConsentClockPolicy = Readonly<z.infer<typeof approvedConsentClockPolicySchema>>;

const invalid = (): never => {
  throw Error("Consent clock policy unavailable");
};

/** Validates an explicitly supplied approved policy. Missing, partial, padded, extra-field or
 * out-of-range input is refused (never normalized or completed with defaults). Returns a
 * frozen copy so a caller cannot mutate the policy after validation. */
export function parseApprovedConsentClockPolicy(input: unknown): ApprovedConsentClockPolicy {
  if (input === null || input === undefined) return invalid();
  const parsed = approvedConsentClockPolicySchema.safeParse(input);
  if (
    !parsed.success ||
    !isDeepStrictEqual(parsed.data, input) ||
    parsed.data.approvalReference.trim() !== parsed.data.approvalReference
  )
    return invalid();
  return Object.freeze({ ...parsed.data });
}

/** An issuing (CURRENT) host profile must carry exactly the approved limits. Equality is
 * required in both directions: a numerically "stricter" value is not automatically safer
 * (for example a smaller `maxDriftPpm` narrows acquisition padding and so the interval). */
export function assertProfileMatchesClockPolicy(
  profile: Pick<QualifiedConsentHost, ConsentClockLimit>,
  policy: ApprovedConsentClockPolicy,
): void {
  for (const limit of CONSENT_CLOCK_LIMITS)
    if (!Object.is(profile[limit], policy[limit])) invalid();
}
