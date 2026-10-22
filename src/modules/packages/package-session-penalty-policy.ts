/** Inactive catalog terms only. These rules do not authorize a purchase or collection.
 * Add a new policy version for future changes; never reinterpret purchased snapshots. */
export const PACKAGE_DEFINITION_CONTRACT_VERSION = 1 as const;
export const PACKAGE_DEFINITION_VALIDITY_CONTRACT_VERSION = 2 as const;
export const PACKAGE_SESSION_PENALTY_POLICY = Object.freeze({
  version: 1 as const,
  currency: "EUR" as const,
  maxBasisCents: 5000,
  appointmentCaptureCapCents: 2500,
  lifetimeCaptureCapCents: 10000,
});

export type PackageDefinitionValidity = { mode: "FINITE"; months: 6 | 12 } | { mode: "FOREVER" };
export type PackageDefinitionContractTerms =
  | {
      version: typeof PACKAGE_DEFINITION_CONTRACT_VERSION;
      validityMonths: 6 | 12;
      penaltyPolicyVersion: typeof PACKAGE_SESSION_PENALTY_POLICY.version;
    }
  | {
      version: typeof PACKAGE_DEFINITION_VALIDITY_CONTRACT_VERSION;
      validity: PackageDefinitionValidity;
      penaltyPolicyVersion: typeof PACKAGE_SESSION_PENALTY_POLICY.version;
    };

/** Copy hydrated nested values without introducing defaults or changing their version. */
export const copyPackageDefinitionContractTerms = (
  terms: PackageDefinitionContractTerms,
): PackageDefinitionContractTerms => {
  if (terms.version === PACKAGE_DEFINITION_CONTRACT_VERSION)
    return {
      version: terms.version,
      validityMonths: terms.validityMonths,
      penaltyPolicyVersion: terms.penaltyPolicyVersion,
    };
  if (
    terms.version !== PACKAGE_DEFINITION_VALIDITY_CONTRACT_VERSION ||
    (terms.validity?.mode !== "FINITE" && terms.validity?.mode !== "FOREVER")
  )
    throw new TypeError("Unsupported Package definition validity");
  return {
    version: terms.version,
    validity:
      terms.validity.mode === "FINITE"
        ? { mode: "FINITE", months: terms.validity.months }
        : { mode: "FOREVER" },
    penaltyPolicyVersion: terms.penaltyPolicyVersion,
  };
};

/** Cap only, never a session price allocation. B=0 always produces zero capacity. */
export const calculatePackageLifetimeCaptureCap = (soldBundlePriceCents: number): number => {
  if (!Number.isSafeInteger(soldBundlePriceCents) || soldBundlePriceCents < 0)
    throw new RangeError("Invalid sold bundle cents");
  const half = BigInt(soldBundlePriceCents) / 2n;
  const ceiling = BigInt(PACKAGE_SESSION_PENALTY_POLICY.lifetimeCaptureCapCents);
  return Number(half < ceiling ? half : ceiling);
};

/** Structural qualification, separate from existing publication/dependency/sellable rules. */
export const hasCompletePackageDefinitionContract = (definition: {
  contractTerms?: PackageDefinitionContractTerms | undefined;
  bundlePriceCents?: number | undefined;
  items: ReadonlyArray<{ penaltyBasisCents?: number | undefined }>;
}): boolean => {
  const terms = definition.contractTerms;
  return (
    terms !== undefined &&
    terms.penaltyPolicyVersion === PACKAGE_SESSION_PENALTY_POLICY.version &&
    ((terms.version === PACKAGE_DEFINITION_CONTRACT_VERSION &&
      (terms.validityMonths === 6 || terms.validityMonths === 12)) ||
      (terms.version === PACKAGE_DEFINITION_VALIDITY_CONTRACT_VERSION &&
        (terms.validity?.mode === "FOREVER" ||
          (terms.validity?.mode === "FINITE" &&
            (terms.validity.months === 6 || terms.validity.months === 12))))) &&
    Number.isSafeInteger(definition.bundlePriceCents) &&
    (definition.bundlePriceCents ?? -1) >= 0 &&
    definition.items.length > 0 &&
    definition.items.every(
      ({ penaltyBasisCents }) =>
        typeof penaltyBasisCents === "number" &&
        Number.isSafeInteger(penaltyBasisCents) &&
        penaltyBasisCents >= 0 &&
        penaltyBasisCents <= PACKAGE_SESSION_PENALTY_POLICY.maxBasisCents,
    )
  );
};
