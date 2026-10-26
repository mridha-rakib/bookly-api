/** TEST-ONLY conditional mathematics/binding probe. Not RFC3161, trusted UTC,
 * genuine consent, a production grant, or a production certificate verifier. */
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const NS_PER_MS = 1_000_000n;
export const LIFETIME_MS = 1_800_000n;
export type ProbeIdentity = {
  claimId: string;
  quoteId: string;
  businessId: string;
  businessClientId: string;
  customerId: string;
  originBookingId: string;
  batchId: string;
  progressId: string;
  termsHash: string;
  disclosureHash: string;
  selectionHash: string;
};
export type ProbeQuote = {
  version: 2;
  identity: ProbeIdentity;
  issuedAtMs: string;
  deadlineMs: string;
  issuanceKind: "ASSUMED_TRUSTED_LOWER_BOUND_TEST_ONLY";
};
export type ProbeConsent = {
  quoteHash: string;
  eventId: string;
  acceptanceId: string;
  familyId: string;
  actionHash: string;
};
export type ProbeWitness = {
  domain: "BOOKLY_PROBE_POST_DURABILITY";
  nonce: string;
  quoteHash: string;
  consentHash: string;
  barrierId: string;
};
export type ProbeToken = {
  kind: "SYNTHETIC_INTERVAL_NOT_TRUSTED_UTC";
  witness: ProbeWitness;
  lowerNs: string;
  upperNs: string;
  signature: string;
};
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw Error("Unserializable probe value");
  return encoded;
};
export const probeDigest = (value: unknown) =>
  createHash("sha256")
    .update(`EXPERIMENT_ONLY:${canonical(value)}`)
    .digest("hex");
const integer = (s: string) => {
  if (typeof s !== "string" || !/^-?(0|[1-9]\d{0,23})$/.test(s) || BigInt(s).toString() !== s)
    throw Error("Unknown/noncanonical time bound");
  return BigInt(s);
};
export const floorMilliseconds = (lowerNs: bigint) => {
  const quotient = lowerNs / NS_PER_MS;
  return lowerNs < 0n && lowerNs % NS_PER_MS !== 0n ? quotient - 1n : quotient;
};
export const probeQuote = (identity: ProbeIdentity, issuanceLowerNs: bigint): ProbeQuote => {
  const q = floorMilliseconds(issuanceLowerNs);
  return {
    version: 2,
    identity,
    issuedAtMs: q.toString(),
    deadlineMs: (q + LIFETIME_MS).toString(),
    issuanceKind: "ASSUMED_TRUSTED_LOWER_BOUND_TEST_ONLY",
  };
};
export const probeWitness = (
  quote: ProbeQuote,
  consent: ProbeConsent,
  barrierId: string,
): ProbeWitness => ({
  domain: "BOOKLY_PROBE_POST_DURABILITY",
  nonce: randomBytes(32).toString("hex"),
  quoteHash: probeDigest(quote),
  consentHash: probeDigest(consent),
  barrierId,
});
const body = (token: Omit<ProbeToken, "signature">) => Buffer.from(canonical(token));
export const syntheticIntervalSigner = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey,
    issue(witness: ProbeWitness, lowerNs: bigint, upperNs: bigint): ProbeToken {
      const payload = {
        kind: "SYNTHETIC_INTERVAL_NOT_TRUSTED_UTC" as const,
        witness,
        lowerNs: lowerNs.toString(),
        upperNs: upperNs.toString(),
      };
      return { ...payload, signature: sign(null, body(payload), privateKey).toString("base64") };
    },
  };
};
export const conditionalProbeCheck = (
  quote: ProbeQuote,
  consent: ProbeConsent,
  expected: ProbeWitness,
  token: ProbeToken,
  key: KeyObject,
) => {
  if (quote.version !== 2 || quote.issuanceKind !== "ASSUMED_TRUSTED_LOWER_BOUND_TEST_ONLY")
    throw Error("Legacy evidence cannot be upgraded");
  if (Object.values(quote.identity).some((v) => typeof v !== "string" || !v))
    throw Error("Incomplete identity");
  const issued = integer(quote.issuedAtMs),
    deadline = integer(quote.deadlineMs);
  if (deadline !== issued + LIFETIME_MS) throw Error("Deadline substitution");
  if (
    consent.quoteHash !== probeDigest(quote) ||
    expected.quoteHash !== probeDigest(quote) ||
    expected.consentHash !== probeDigest(consent)
  )
    throw Error("Quote/consent binding mismatch");
  if (
    expected.domain !== "BOOKLY_PROBE_POST_DURABILITY" ||
    !/^[a-f0-9]{64}$/.test(expected.nonce) ||
    !expected.barrierId ||
    !isDeepStrictEqual(expected, token.witness)
  )
    throw Error("Stale/foreign witness");
  const lower = integer(token.lowerNs),
    upper = integer(token.upperNs);
  if (lower > upper || token.kind !== "SYNTHETIC_INTERVAL_NOT_TRUSTED_UTC")
    throw Error("Invalid interval");
  const { signature, ...payload } = token;
  if (!verify(null, body(payload), key, Buffer.from(signature, "base64")))
    throw Error("Invalid synthetic signature");
  return upper < deadline * NS_PER_MS
    ? "CONDITIONAL_BOUND_SATISFIED"
    : "REFUSE_UNCERTAIN_OR_LATE_BOUND";
};
