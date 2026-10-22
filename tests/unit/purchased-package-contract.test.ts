import { Types } from "mongoose";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  acceptedActivationWindowSchema,
  type PurchasedItemContract,
  purchasedAcceptanceEvidenceSchema,
  purchasedActivationEvidenceSchema,
  purchasedDefinitionReferenceSchema,
  purchasedDefinitionTermsSchema,
  purchasedItemContractSchema,
  purchasedItemIdentitySchema,
  purchasedPackageContractFragmentsSchema,
  purchasedPenaltyContractSchema,
  purchasedValidityContractSchema,
} from "../../src/modules/package-progress/purchased-package-contract.js";

// Explicit synthetic evidence, not a production purchase/activation factory.
const ids = Array.from(
  { length: 20 },
  (_, index) => new Types.ObjectId((index + 1).toString(16).padStart(24, "0")),
);
const identity = () => ({ packageItemId: ids[1], definitionItemId: ids[2], serviceId: ids[3] });
const item = () => ({
  version: 1,
  packageId: ids[0],
  packageRevision: 3,
  ...identity(),
  totalSessions: 5,
  penaltyBasisCents: 5000,
  provenance: "ACCEPTED_DEFINITION_ITEM",
});
const penalty = () => ({
  policyVersion: 1,
  currency: "EUR",
  soldBundlePriceCents: 19999,
  appointmentCapCents: 2500,
  lifetimeCapCents: 9999,
  noPurchaseDepositOffset: true,
  scope: "INCLUDED_SESSION_ONLY",
  provenance: "ACCEPTED_SOLD_BUNDLE_PRICE",
  captureBudgetSemantics: {
    succeeded: "PERMANENT_SPEND",
    pendingOrUnknown: "RESERVE",
    definitiveNonCollection: "RELEASE",
    refundsAndDisputes: "NO_CAPACITY_RESTORE",
    fixedAssessment: "NO_AUTOMATIC_TOP_UP",
  },
});
const window = () => ({
  version: 1,
  quoteId: ids[4],
  batchId: ids[5],
  notBefore: new Date("2026-01-31T05:00:00Z"),
  notAfterExclusive: new Date("2026-01-31T07:00:00Z"),
});
const finite = (months = 6) => ({
  contractVersion: 1,
  mode: "FINITE",
  months,
  purchasedAt: new Date("2026-01-31T06:00:00Z"),
  activationId: ids[6],
  batchId: ids[5],
  timezone: "Asia/Dhaka",
  expiresAt: new Date("2026-07-31T06:00:00Z"),
  calculation: { version: 1, provenanceRef: ids[7] },
  activationWindow: window(),
  expiryDisclosure: {
    version: 1,
    quoteId: ids[4],
    acceptedTermsPayloadId: ids[8],
    acceptedTermsHash: "a".repeat(64),
    guaranteedNotBeforeExpiry: new Date("2026-07-31T05:00:00Z"),
  },
});
const forever = () => ({
  contractVersion: 1,
  mode: "FOREVER",
  purchasedAt: new Date("2026-01-31T06:00:00Z"),
  activationId: ids[6],
  batchId: ids[5],
});
const acceptance = () => ({
  version: 1,
  contractVersion: 1,
  acceptanceId: ids[9],
  acceptedTermsPayloadId: ids[8],
  acceptedTermsHash: "a".repeat(64),
  templateId: ids[10],
  templateVersion: 1,
  actorUserId: ids[11],
  customerUserId: ids[11],
  actorRole: "CUSTOMER",
  acceptedAt: new Date("2026-01-31T05:30:00Z"),
  businessId: ids[12],
  packageId: ids[0],
  packageRevision: 3,
  packageProgressId: ids[13],
  batchId: ids[5],
  quoteId: ids[4],
  provenance: "CUSTOMER_ACCEPTANCE_RECORD",
  scope: "PURCHASE",
  items: [identity()],
});
const activation = () => ({
  version: 1,
  contractVersion: 1,
  activationId: ids[6],
  activationEventId: ids[14],
  batchId: ids[5],
  packageProgressId: ids[13],
  businessId: ids[12],
  customerUserId: ids[11],
  packageId: ids[0],
  packageRevision: 3,
  acceptanceId: ids[9],
  purchasedAt: new Date("2026-01-31T06:00:00Z"),
  provenance: "WINNING_BATCH_ACTIVATION_EVENT",
});
const fragments = () => ({
  contractVersion: 1,
  definition: {
    packageId: ids[0],
    packageRevision: 3,
    contractTerms: { version: 1, validityMonths: 6, penaltyPolicyVersion: 1 },
  },
  validity: finite(),
  penalty: penalty(),
  items: [item()],
  acceptance: acceptance(),
  activation: activation(),
});
const without = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

describe("unwired purchased validity data", () => {
  it.each([6, 12])("accepts explicit FINITE %i without computing its deadline", (months) => {
    // Even 12 months deliberately uses an arbitrary explicit, ordered deadline.
    // Semantic anniversary/guarantee proof belongs to future authoritative P3.
    expect(purchasedValidityContractSchema.parse(finite(months)).mode).toBe("FINITE");
  });
  it("accepts FOREVER without finite data or generated fields", () => {
    expect(purchasedValidityContractSchema.parse(forever())).toEqual(forever());
  });
  it.each([
    "months",
    "validityMonths",
    "expiresAt",
    "timezone",
    "expiryDisclosure",
    "activationWindow",
    "calculation",
  ])("rejects FOREVER with finite field %s, including sentinels", (key) => {
    expect(
      purchasedValidityContractSchema.safeParse({ ...forever(), [key]: finite().expiresAt })
        .success,
    ).toBe(false);
  });
  it.each([undefined, {}, { mode: "UNKNOWN" }, { ...forever(), mode: undefined }])(
    "does not infer missing/unsupported validity: %j",
    (value) => expect(purchasedValidityContractSchema.safeParse(value).success).toBe(false),
  );
  it.each([
    "purchasedAt",
    "activationId",
    "batchId",
    "contractVersion",
    "expiresAt",
    "months",
    "timezone",
    "calculation",
    "activationWindow",
    "expiryDisclosure",
  ])("requires explicit finite %s", (key) =>
    expect(purchasedValidityContractSchema.safeParse(without(finite(), key)).success).toBe(false),
  );
  it.each(["Asia/Dhaka", "Europe/Nicosia", "America/New_York", "UTC", "Etc/GMT-6"])(
    "accepts named zone %s without changing it",
    (timezone) => {
      const result = purchasedValidityContractSchema.parse({ ...finite(), timezone });
      expect(result.mode === "FINITE" && result.timezone).toBe(timezone);
    },
  );
  it.each(["", "No/Such_Zone", "+06:00", "Z", " Asia/Dhaka "])(
    "rejects invalid/offset zone %s",
    (timezone) =>
      expect(purchasedValidityContractSchema.safeParse({ ...finite(), timezone }).success).toBe(
        false,
      ),
  );
  it.each([null, "2026-01-31T06:00:00Z", new Date(Number.NaN)])(
    "rejects invalid date %s",
    (purchasedAt) => {
      expect(purchasedValidityContractSchema.safeParse({ ...forever(), purchasedAt }).success).toBe(
        false,
      );
    },
  );
  it("rejects basic time, batch, quote and version inconsistencies", () => {
    const valid = finite();
    for (const input of [
      { ...valid, contractVersion: 2 },
      { ...valid, months: 7 },
      { ...valid, calculation: { ...valid.calculation, version: 2 } },
      { ...valid, expiresAt: valid.purchasedAt },
      { ...valid, purchasedAt: valid.activationWindow.notAfterExclusive },
      { ...valid, purchasedAt: new Date("2026-01-31T04:59:59Z") },
      { ...valid, batchId: ids[19] },
      { ...valid, expiryDisclosure: { ...valid.expiryDisclosure, quoteId: ids[19] } },
      {
        ...valid,
        expiryDisclosure: {
          ...valid.expiryDisclosure,
          guaranteedNotBeforeExpiry: valid.purchasedAt,
        },
      },
      {
        ...valid,
        expiryDisclosure: {
          ...valid.expiryDisclosure,
          guaranteedNotBeforeExpiry: new Date("2027-01-01Z"),
        },
      },
    ])
      expect(purchasedValidityContractSchema.safeParse(input).success).toBe(false);
    expect(
      acceptedActivationWindowSchema.safeParse({
        ...window(),
        notBefore: window().notAfterExclusive,
      }).success,
    ).toBe(false);
    expect(
      purchasedValidityContractSchema.safeParse({
        ...valid,
        purchasedAt: valid.activationWindow.notBefore,
      }).success,
    ).toBe(true);
  });
});

describe("catalog source and independent item principal", () => {
  it.each([
    { version: 1, validityMonths: 6, penaltyPolicyVersion: 1 },
    { version: 1, validityMonths: 12, penaltyPolicyVersion: 1 },
    { version: 2, validity: { mode: "FINITE", months: 6 }, penaltyPolicyVersion: 1 },
    { version: 2, validity: { mode: "FINITE", months: 12 }, penaltyPolicyVersion: 1 },
    { version: 2, validity: { mode: "FOREVER" }, penaltyPolicyVersion: 1 },
  ])("preserves stored definition representation %j", (terms) => {
    expect(purchasedDefinitionTermsSchema.parse(terms)).toEqual(terms);
  });
  it.each([
    {},
    { version: 3 },
    { version: 1, validity: { mode: "FOREVER" }, penaltyPolicyVersion: 1 },
    { version: 2, validityMonths: 6, penaltyPolicyVersion: 1 },
    { version: 2, validity: { mode: "FOREVER", months: 6 }, penaltyPolicyVersion: 1 },
    { version: 1, validityMonths: 6, penaltyPolicyVersion: 2 },
  ])("rejects missing, unsupported or hybrid catalog terms %j", (terms) => {
    expect(purchasedDefinitionTermsSchema.safeParse(terms).success).toBe(false);
  });
  it.each([0, 5000])("accepts explicit independent P=%i", (penaltyBasisCents) => {
    expect(
      purchasedItemContractSchema.parse({ ...item(), penaltyBasisCents }).penaltyBasisCents,
    ).toBe(penaltyBasisCents);
  });
  it.each([-1, 0.1, 5001, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, "0", null])(
    "rejects malformed/out-of-range P=%s",
    (penaltyBasisCents) => {
      expect(purchasedItemContractSchema.safeParse({ ...item(), penaltyBasisCents }).success).toBe(
        false,
      );
    },
  );
  it.each([
    "packageId",
    "packageRevision",
    "packageItemId",
    "definitionItemId",
    "serviceId",
    "totalSessions",
    "penaltyBasisCents",
    "provenance",
    "version",
  ])("requires explicit item %s", (key) =>
    expect(purchasedItemContractSchema.safeParse(without(item(), key)).success).toBe(false),
  );
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "5"])(
    "rejects quantity %s",
    (totalSessions) => {
      expect(purchasedItemContractSchema.safeParse({ ...item(), totalSessions }).success).toBe(
        false,
      );
    },
  );
  it("accepts existing maximum safe quantity without a commercial ceiling", () => {
    expect(
      purchasedItemContractSchema.parse({ ...item(), totalSessions: Number.MAX_SAFE_INTEGER })
        .totalSessions,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("requires internal ObjectIds and rejects reference price as principal or an extra field", () => {
    expect(
      purchasedItemIdentitySchema.safeParse({ ...identity(), serviceId: ids[3]?.toHexString() })
        .success,
    ).toBe(false);
    expect(
      purchasedItemContractSchema.safeParse({
        ...without(item(), "penaltyBasisCents"),
        referenceUnitPriceCents: 5000,
      }).success,
    ).toBe(false);
    expect(
      purchasedItemContractSchema.safeParse({ ...item(), referenceUnitPriceCents: 5000 }).success,
    ).toBe(false);
    expect(
      purchasedDefinitionReferenceSchema.safeParse({ packageId: "bad", packageRevision: 1 })
        .success,
    ).toBe(false);
  });
});

describe("fixed Option B snapshot", () => {
  it.each([
    [0, 0],
    [1, 0],
    [50, 25],
    [3000, 1500],
    [19999, 9999],
    [20000, 10000],
    [Number.MAX_SAFE_INTEGER, 10000],
  ])("validates B=%i L=%i exactly", (soldBundlePriceCents, lifetimeCapCents) => {
    expect(
      purchasedPenaltyContractSchema.safeParse({
        ...penalty(),
        soldBundlePriceCents,
        lifetimeCapCents,
      }).success,
    ).toBe(true);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, "100", null])(
    "rejects invalid B=%s without throwing",
    (soldBundlePriceCents) => {
      expect(
        purchasedPenaltyContractSchema.safeParse({ ...penalty(), soldBundlePriceCents }).success,
      ).toBe(false);
    },
  );
  it.each([
    { policyVersion: 2 },
    { currency: "USD" },
    { appointmentCapCents: 2501 },
    { lifetimeCapCents: 10000 },
    { lifetimeCapCents: -1 },
    { lifetimeCapCents: 0.5 },
    { noPurchaseDepositOffset: false },
    { scope: "ALL_EXTRAS" },
    { maxBasisCents: 10000 },
    { lifetimeFormula: "B" },
    { ownerCap: 1000 },
    { provenance: "REFERENCE_TOTAL" },
  ])("rejects altered policy or extra monetary controls %j", (override) => {
    expect(purchasedPenaltyContractSchema.safeParse({ ...penalty(), ...override }).success).toBe(
      false,
    );
  });
  it.each([
    "succeeded",
    "pendingOrUnknown",
    "definitiveNonCollection",
    "refundsAndDisputes",
    "fixedAssessment",
  ])("requires fixed capture semantics %s", (key) => {
    expect(
      purchasedPenaltyContractSchema.safeParse({
        ...penalty(),
        captureBudgetSemantics: { ...penalty().captureBudgetSemantics, [key]: "RESET" },
      }).success,
    ).toBe(false);
  });
});

describe("evidence is explicit data, not authority", () => {
  it("accepts purchase and exact appointment acceptance without creating a Booking", () => {
    expect(purchasedAcceptanceEvidenceSchema.parse(acceptance()).scope).toBe("PURCHASE");
    const { items: _items, ...common } = acceptance();
    expect(
      purchasedAcceptanceEvidenceSchema.parse({
        ...common,
        scope: "APPOINTMENT",
        bookingId: ids[15],
        item: identity(),
      }).scope,
    ).toBe("APPOINTMENT");
  });
  it.each([
    "version",
    "contractVersion",
    "acceptanceId",
    "acceptedTermsPayloadId",
    "acceptedTermsHash",
    "templateId",
    "templateVersion",
    "actorUserId",
    "customerUserId",
    "acceptedAt",
    "businessId",
    "packageId",
    "packageRevision",
    "packageProgressId",
    "batchId",
    "quoteId",
    "items",
    "provenance",
  ])("requires acceptance evidence %s", (key) =>
    expect(purchasedAcceptanceEvidenceSchema.safeParse(without(acceptance(), key)).success).toBe(
      false,
    ),
  );
  it.each([
    { version: 2 },
    { templateVersion: 2 },
    { acceptedTermsHash: "bad" },
    { acceptedTermsHash: "A".repeat(64) },
    { acceptedTermsPayloadId: "bad" },
    { actorUserId: ids[19] },
    { actorRole: "BUSINESS_OWNER" },
    { items: [] },
    { items: [identity(), identity()] },
    { accepted: true },
    { paymentSucceeded: true },
  ])("rejects invalid acceptance evidence %j", (override) => {
    expect(
      purchasedAcceptanceEvidenceSchema.safeParse({ ...acceptance(), ...override }).success,
    ).toBe(false);
  });
  it.each(["purchasedAt", "activationId", "activationEventId", "acceptanceId", "provenance"])(
    "does not generate activation %s",
    (key) =>
      expect(purchasedActivationEvidenceSchema.safeParse(without(activation(), key)).success).toBe(
        false,
      ),
  );
  it("rejects fake payment authority or accounting fields on activation", () => {
    expect(
      purchasedActivationEvidenceSchema.safeParse({ ...activation(), paymentSucceeded: true })
        .success,
    ).toBe(false);
    expect(
      purchasedActivationEvidenceSchema.safeParse({ ...activation(), creditAccountingVersion: 2 })
        .success,
    ).toBe(false);
  });
});

describe("correlated fragments remain unwired", () => {
  it("accepts a complete synthetic set, preserving explicit dates and frozen containers", () => {
    const input = fragments();
    const output = purchasedPackageContractFragmentsSchema.parse(input);
    expect(output).toEqual(input);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.items)).toBe(true);
    expect(Object.isFrozen(output.items[0])).toBe(true);
    expect(Object.isFrozen(output.definition.contractTerms)).toBe(true);
    expectTypeOf<Pick<PurchasedItemContract, "penaltyBasisCents">>().toEqualTypeOf<{
      readonly penaltyBasisCents: number;
    }>();
  });
  it("supports explicit v2 FINITE and FOREVER; neither version nor mode is upgraded", () => {
    const input = fragments();
    for (const months of [6, 12]) {
      expect(
        purchasedPackageContractFragmentsSchema.safeParse({
          ...input,
          definition: {
            ...input.definition,
            contractTerms: {
              version: 2,
              validity: { mode: "FINITE", months },
              penaltyPolicyVersion: 1,
            },
          },
          validity: finite(months),
        }).success,
      ).toBe(true);
    }
    expect(
      purchasedPackageContractFragmentsSchema.safeParse({
        ...input,
        definition: {
          ...input.definition,
          contractTerms: { version: 2, validity: { mode: "FOREVER" }, penaltyPolicyVersion: 1 },
        },
        validity: forever(),
      }).success,
    ).toBe(true);
    expect(
      purchasedPackageContractFragmentsSchema.safeParse({ ...input, validity: forever() }).success,
    ).toBe(false);
  });
  it("zero B permits independent positive P but never positive lifetime capacity", () => {
    const input = fragments();
    const zero = {
      ...input,
      penalty: { ...penalty(), soldBundlePriceCents: 0, lifetimeCapCents: 0 },
    };
    expect(purchasedPackageContractFragmentsSchema.parse(zero).items[0]?.penaltyBasisCents).toBe(
      5000,
    );
    expect(
      purchasedPackageContractFragmentsSchema.safeParse({
        ...zero,
        penalty: { ...zero.penalty, lifetimeCapCents: 1 },
      }).success,
    ).toBe(false);
  });
  it("rejects absent fragments, legacy balances and unknown integration fields", () => {
    for (const key of Object.keys(fragments()))
      expect(
        purchasedPackageContractFragmentsSchema.safeParse(without(fragments(), key)).success,
      ).toBe(false);
    expect(
      purchasedPackageContractFragmentsSchema.safeParse({ ...fragments(), schemaVersion: 2 })
        .success,
    ).toBe(false);
    expect(purchasedItemContractSchema.safeParse({ ...item(), remainingSessions: 5 }).success).toBe(
      false,
    );
  });
  it("checks exact evidence/item correlations, not merely individually valid fields", () => {
    const input = fragments();
    const variants = [
      { ...input, items: [item(), item()] },
      { ...input, items: [{ ...item(), packageRevision: 4 }] },
      { ...input, items: [{ ...item(), packageId: ids[19] }] },
      { ...input, validity: finite(12) },
      { ...input, acceptance: { ...acceptance(), items: [{ ...identity(), serviceId: ids[19] }] } },
      { ...input, acceptance: { ...acceptance(), quoteId: ids[19] } },
      { ...input, acceptance: { ...acceptance(), acceptedTermsHash: "b".repeat(64) } },
      { ...input, acceptance: { ...acceptance(), acceptedAt: new Date("2026-02-01Z") } },
      { ...input, activation: { ...activation(), purchasedAt: new Date("2026-02-01Z") } },
      ...[
        "businessId",
        "customerUserId",
        "packageId",
        "packageProgressId",
        "acceptanceId",
        "activationId",
        "batchId",
      ].map((key) => ({ ...input, activation: { ...activation(), [key]: ids[19] } })),
    ];
    for (const variant of variants)
      expect(purchasedPackageContractFragmentsSchema.safeParse(variant).success).toBe(false);
  });
  it("retains safe aggregate quantities using exact arithmetic", () => {
    const input = fragments();
    const secondIdentity = {
      packageItemId: ids[16],
      definitionItemId: ids[17],
      serviceId: ids[18],
    };
    const second = { ...item(), ...secondIdentity, totalSessions: 1 };
    const make = (firstCount: number) => ({
      ...input,
      items: [{ ...item(), totalSessions: firstCount }, second],
      acceptance: { ...acceptance(), items: [identity(), secondIdentity] },
    });
    expect(
      purchasedPackageContractFragmentsSchema.safeParse(make(Number.MAX_SAFE_INTEGER - 1)).success,
    ).toBe(true);
    expect(
      purchasedPackageContractFragmentsSchema.safeParse(make(Number.MAX_SAFE_INTEGER)).success,
    ).toBe(false);
  });
  it("rejects malformed leaves in the combined parser without throwing", () => {
    const input = fragments();
    for (const value of [
      undefined,
      null,
      "bad",
      -1,
      0.5,
      Number.NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      for (const field of ["totalSessions", "penaltyBasisCents", "serviceId"])
        expect(
          purchasedPackageContractFragmentsSchema.safeParse({
            ...input,
            items: [{ ...item(), [field]: value }],
          }).success,
        ).toBe(false);
      expect(
        purchasedPackageContractFragmentsSchema.safeParse({
          ...input,
          penalty: { ...penalty(), soldBundlePriceCents: value },
        }).success,
      ).toBe(false);
    }
  });
  it("rejects unknown fields at nested evidence and provenance boundaries", () => {
    const input = fragments();
    const valid = finite();
    for (const invalid of [
      { ...input, definition: { ...input.definition, ownerOverride: true } },
      {
        ...input,
        definition: {
          ...input.definition,
          contractTerms: { ...input.definition.contractTerms, currency: "EUR" },
        },
      },
      {
        ...input,
        validity: { ...valid, calculation: { ...valid.calculation, dstPolicy: "GUESS" } },
      },
      {
        ...input,
        validity: {
          ...valid,
          expiryDisclosure: { ...valid.expiryDisclosure, consentVerified: true },
        },
      },
      {
        ...input,
        validity: { ...valid, activationWindow: { ...window(), extendAutomatically: true } },
      },
      {
        ...input,
        penalty: {
          ...penalty(),
          captureBudgetSemantics: { ...penalty().captureBudgetSemantics, resetsOnRedemption: true },
        },
      },
    ])
      expect(purchasedPackageContractFragmentsSchema.safeParse(invalid).success).toBe(false);
  });
  it("keeps later appointment acceptance separate from the original purchase fragments", () => {
    const input = fragments();
    const { items: _items, ...common } = acceptance();
    const later = {
      ...common,
      scope: "APPOINTMENT",
      bookingId: ids[15],
      item: identity(),
      acceptedAt: new Date("2026-08-01T06:00:00Z"),
    };
    expect(purchasedAcceptanceEvidenceSchema.safeParse(later).success).toBe(true);
    expect(
      purchasedPackageContractFragmentsSchema.safeParse({ ...input, acceptance: later }).success,
    ).toBe(false);
  });
});
