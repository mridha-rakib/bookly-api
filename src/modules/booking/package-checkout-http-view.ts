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
    // Read-only restoration of the original selections, straight from the retained (signed)
    // payload. Only the authorised owning Customer reaches this view; no coordinates are exposed.
    appointments: q.appointments.map((a) => {
      const money = q.financials.appointments.find((row) => row.bookingId.equals(a.bookingId));
      return {
        selectionId: String(a.selectionId),
        definitionItemId: String(a.definitionItemId),
        serviceId: String(a.serviceId),
        serviceName: q.items.find((i) => i.packageItemId.equals(a.packageItemId))?.serviceName,
        staffMembershipId: String(a.staffMembershipId),
        startAt: a.startAt,
        endAt: a.endAt,
        durationMin: a.timing.baseDurationMin,
        addons: a.addons.map((addon) => ({
          id: String(addon.addonId),
          name: addon.name,
          priceCents: addon.priceCents,
        })),
        location:
          a.location.mode === "TRAVEL_TO_CUSTOMER"
            ? { mode: a.location.mode, address: withoutCoordinates(a.location.travelAddress) }
            : { mode: a.location.mode, address: withoutCoordinates(a.location.businessLocation) },
        travelFeeCents: a.travelFeeCents,
        ...(money
          ? {
              financials: {
                includedBaseCents: money.includedBaseCents,
                addonsCents: money.addonsCents,
                travelCents: money.travelCents,
                upfrontCents: money.upfrontCents,
                manualVenueDuesCents: money.manualVenueDuesCents,
              },
            }
          : {}),
      };
    }),
  };
}

const withoutCoordinates = <T extends { location?: unknown }>({
  location: _location,
  ...rest
}: T) => rest;
