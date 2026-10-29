import type { PackageCheckoutRetention } from "./package-checkout-retention.js";

/** The retained quote is never reissued for this DTO, including retrieval after expiry.
 * Application issuance time and ACCEPTED_IMMUTABLE remain explicitly uncertified. */
export function packageCheckoutHttpView(retention: PackageCheckoutRetention) {
  const q = retention.quote.payload;
  return {
    quoteId: String(q.quoteId),
    termsHash: retention.quote.termsHash,
    issuedAt: q.issuedAt,
    expiresAt: q.expiresAt,
    timezone: q.businessTimezone,
    lifetimeMs: q.expiresAt.getTime() - q.issuedAt.getTime(),
    issuanceAuthority: retention.seed.consentEvidenceId
      ? ("HOST_EVIDENCE_REQUIRES_VERIFICATION" as const)
      : ("APPLICATION_CLOCK_NOT_CERTIFIED" as const),
    certification: "UNRESOLVED" as const,
    purchaseAvailable: false,
    packageId: String(q.packageId),
    name: q.packageName,
    validity:
      q.validity.mode === "FOREVER"
        ? { mode: "FOREVER" as const }
        : {
            mode: "FINITE" as const,
            months: q.validity.months,
            timezone: q.validity.timezone,
            estimatedExpiresAt: q.validity.estimatedExpiresAt,
          },
    financials: {
      currency: q.financials.currency,
      bundlePriceCents: q.financials.bundlePriceCents,
      addonsCents: q.financials.addonsCents,
      travelCents: q.financials.travelCents,
      normalTotalCents: q.financials.normalTotalCents,
      requiredUpfrontCents: q.financials.requiredUpfrontCents,
      manualVenueDuesCents: q.financials.manualVenueDuesCents,
      classification: q.financials.classification,
    },
    items: q.items.map((i) => ({
      serviceId: String(i.serviceId),
      name: i.serviceName,
      quantity: i.totalSessions,
    })),
    appointments: q.appointments.map((a) => ({
      selectionId: String(a.selectionId),
      serviceId: String(a.serviceId),
      staffMembershipId: String(a.staffMembershipId),
      startAt: a.startAt,
      endAt: a.endAt,
    })),
  };
}
