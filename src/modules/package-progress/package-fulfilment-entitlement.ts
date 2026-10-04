import type { BookingDocument } from "../booking/booking.model.js";
import type { BusinessTravelSettingsDocument } from "../business-travel-settings/business-travel-settings.model.js";
import type { ServiceDocument } from "../services/service.model.js";
import { PackageProgressError } from "./package-progress.errors.js";
import type {
  PackageFulfilmentEntitlement,
  PackageProgressDocument,
} from "./package-progress.model.js";

/** Captures capability and its contractual per-visit travel pricing, while deliberately leaving
 * staff, schedules, opening hours and the Business's physical address live. */
export const buildPackageFulfilmentEntitlement = (
  originBooking: Pick<BookingDocument, "fulfilment">,
  service: Pick<ServiceDocument, "servedCities">,
  travelSettings: Pick<BusinessTravelSettingsDocument, "cities"> | null,
): PackageFulfilmentEntitlement => {
  if (originBooking.fulfilment.mode === "AT_BUSINESS_LOCATION") {
    return { mode: "AT_BUSINESS_LOCATION" };
  }

  const served = new Set(service.servedCities);
  const travelCities = (travelSettings?.cities ?? [])
    .filter((entry) => entry.active && served.has(entry.city))
    .map((entry) => ({ city: entry.city, feeCents: entry.feeCents }));

  if (travelCities.length === 0) {
    throw new PackageProgressError("PACKAGE_PROGRESS_FULFILMENT_INVALID", 409);
  }

  return { mode: "TRAVEL_TO_CUSTOMER", travelCities };
};

/** Legacy records predate the entitlement field. Their origin Booking is the safest historical
 * evidence: preserve its mode and, for travel, its proven city and charged per-visit fee. */
export const resolvePackageFulfilmentEntitlement = (
  progress: Pick<PackageProgressDocument, "purchaseSnapshot">,
  originBooking: Pick<BookingDocument, "fulfilment" | "financials">,
): PackageFulfilmentEntitlement => {
  const stored = progress.purchaseSnapshot.fulfilmentEntitlement;
  if (stored) {
    if (
      stored.mode === "TRAVEL_TO_CUSTOMER" &&
      (!stored.travelCities || stored.travelCities.length === 0)
    ) {
      throw new PackageProgressError("PACKAGE_PROGRESS_FULFILMENT_INVALID", 409);
    }
    return stored;
  }

  if (originBooking.fulfilment.mode === "AT_BUSINESS_LOCATION") {
    return { mode: "AT_BUSINESS_LOCATION" };
  }

  const city = originBooking.fulfilment.travelAddress?.city;
  if (!city) {
    throw new PackageProgressError("PACKAGE_PROGRESS_FULFILMENT_INVALID", 409);
  }

  return {
    mode: "TRAVEL_TO_CUSTOMER",
    travelCities: [{ city, feeCents: originBooking.financials.travelFeeCents }],
  };
};
