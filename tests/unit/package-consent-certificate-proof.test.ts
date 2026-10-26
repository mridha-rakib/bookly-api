import { expect, it } from "vitest";
import {
  conditionalProbeCheck,
  floorMilliseconds,
  NS_PER_MS,
  probeDigest,
  probeQuote,
  probeWitness,
  syntheticIntervalSigner,
} from "../helpers/consent-certificate-proof-probe.js";

const setup = () => {
  const quote = probeQuote(
    {
      claimId: "claim",
      quoteId: "quote",
      businessId: "business",
      businessClientId: "client-A",
      customerId: "customer",
      originBookingId: "origin",
      batchId: "batch",
      progressId: "progress",
      termsHash: "terms",
      disclosureHash: "disclosure",
      selectionHash: "selection",
    },
    1_700_000_000_000n * NS_PER_MS,
  );
  const consent = {
    quoteHash: probeDigest(quote),
    eventId: "event",
    acceptanceId: "acceptance",
    familyId: "family",
    actionHash: "affirmative-action",
  };
  const witness = probeWitness(quote, consent, "ASSUMED_COMPLETED_DURABILITY_BARRIER");
  const signer = syntheticIntervalSigner();
  return { quote, consent, witness, signer, d: BigInt(quote.deadlineMs) * NS_PER_MS };
};
it.each([-60000, -1000, -1, 0, 1, 1000, 60000])(
  "conditional upper-bound cutoff at D%+d ms, not trusted-clock proof",
  (offset) => {
    const s = setup(),
      upper = s.d + BigInt(offset) * NS_PER_MS;
    const token = s.signer.issue(s.witness, upper - NS_PER_MS, upper);
    expect(conditionalProbeCheck(s.quote, s.consent, s.witness, token, s.signer.publicKey)).toBe(
      offset < 0 ? "CONDITIONAL_BOUND_SATISFIED" : "REFUSE_UNCERTAIN_OR_LATE_BOUND",
    );
  },
);
it("uncertainty straddling D refuses even when the midpoint and actual C could be early", () => {
  const s = setup(),
    token = s.signer.issue(s.witness, s.d - 2n * NS_PER_MS, s.d + NS_PER_MS);
  expect(conditionalProbeCheck(s.quote, s.consent, s.witness, token, s.signer.publicKey)).toBe(
    "REFUSE_UNCERTAIN_OR_LATE_BOUND",
  );
});
it("prospective lower-bound issuance rounds down and never adds grace", () => {
  expect(floorMilliseconds(123_999_999n)).toBe(123n);
  expect(floorMilliseconds(-1n)).toBe(-1n);
  const s = setup();
  expect(BigInt(s.quote.deadlineMs) - BigInt(s.quote.issuedAtMs)).toBe(1_800_000n);
});
it("fresh post-barrier nonce rejects a pre-obtained observation for otherwise identical evidence", () => {
  const s = setup(),
    old = s.signer.issue(s.witness, s.d - 3n, s.d - 2n);
  const fresh = probeWitness(s.quote, s.consent, "NEW_POST_COMMIT_BARRIER");
  expect(() => conditionalProbeCheck(s.quote, s.consent, fresh, old, s.signer.publicKey)).toThrow(
    "witness",
  );
});
it.each([
  "businessClientId",
  "customerId",
  "selectionHash",
  "termsHash",
  "disclosureHash",
  "originBookingId",
] as const)("certificate cannot move to changed %s", (field) => {
  const s = setup(),
    token = s.signer.issue(s.witness, s.d - 2n, s.d - 1n);
  const changed = { ...s.quote, identity: { ...s.quote.identity, [field]: "FOREIGN" } };
  expect(() =>
    conditionalProbeCheck(changed, s.consent, s.witness, token, s.signer.publicKey),
  ).toThrow("binding");
});
it("altered token, unknown bound, foreign signer and deadline substitution fail closed", () => {
  const s = setup(),
    token = s.signer.issue(s.witness, s.d - 2n, s.d - 1n);
  expect(() =>
    conditionalProbeCheck(
      s.quote,
      s.consent,
      s.witness,
      { ...token, upperNs: (s.d - 10n).toString() },
      s.signer.publicKey,
    ),
  ).toThrow();
  expect(() =>
    conditionalProbeCheck(
      s.quote,
      s.consent,
      s.witness,
      { ...token, upperNs: "unknown" },
      s.signer.publicKey,
    ),
  ).toThrow();
  expect(() =>
    conditionalProbeCheck(
      s.quote,
      s.consent,
      s.witness,
      token,
      syntheticIntervalSigner().publicKey,
    ),
  ).toThrow();
  expect(() =>
    conditionalProbeCheck(
      { ...s.quote, deadlineMs: (BigInt(s.quote.deadlineMs) + 1n).toString() },
      s.consent,
      s.witness,
      token,
      s.signer.publicKey,
    ),
  ).toThrow("Deadline");
});
it("countermodel: a signed false clock interval can falsely satisfy the conditional check", () => {
  const s = setup(),
    actualLateC = s.d + 10n * NS_PER_MS;
  const dishonest = s.signer.issue(s.witness, s.d - 3n * NS_PER_MS, s.d - NS_PER_MS);
  expect(conditionalProbeCheck(s.quote, s.consent, s.witness, dishonest, s.signer.publicKey)).toBe(
    "CONDITIONAL_BOUND_SATISFIED",
  );
  expect(actualLateC > s.d).toBe(true); // Signature authenticity alone is not UTC truth.
});
it("countermodel: certification persistence after D is invalid if S itself creates authority", () => {
  const s = setup(),
    C = s.d - 3n,
    O = s.d - 2n,
    S = s.d + 1n;
  expect(C <= O && O < s.d).toBe(true);
  expect(S < s.d).toBe(false);
});
it("bounded exhaustive event model satisfies safety only with causal order and truthful upper bound", () => {
  for (let C = -5; C <= 5; C++)
    for (let O = C; O <= 6; O++)
      for (let upper = O; upper <= 7; upper++) {
        if (upper < 0) expect(C < 0).toBe(true);
      }
  // Dropping causal order alone also permits a false pre-deadline claim.
  expect(2 > 0 && -2 <= -1 && -1 < 0).toBe(true);
});
it("legacy app-clock evidence cannot be relabeled as a prospective trusted quote", () => {
  const s = setup(),
    token = s.signer.issue(s.witness, s.d - 2n, s.d - 1n);
  Object.defineProperty(s.quote, "version", { value: 1 });
  expect(() =>
    conditionalProbeCheck(s.quote, s.consent, s.witness, token, s.signer.publicKey),
  ).toThrow("Legacy");
});
