import type { BusinessCity } from "../business/business.types.js";
import type { ClientPropertyType } from "../client/client.types.js";

export type CreateBookingServiceLineInput = {
  serviceId: string;
  staffMembershipId: string;
  addonIds: string[];
  pricingInput: {
    hours?: number | undefined;
    personCount?: number | undefined;
  };
};

export type CreateBookingTravelAddressInput = {
  city: BusinessCity;
  propertyType: ClientPropertyType;
  area: string;
  streetName: string;
  streetNumber: string;
  floorUnit?: string | undefined;
  aptRoom?: string | undefined;
  additionalDirections?: string | undefined;
};

/**
 * Shared shape between the Manual and Customer booking-creation entry points
 * (BookingCreationService). `startAt` is the single, shared, absolute instant every service
 * line begins at — see BookingCreationService's own module doc comment for why a multi-line
 * Booking's lines run in PARALLEL (same start, each line's own duration/staff), not
 * sequentially: the existing schema has exactly one root `schedule`, never a per-line one, and
 * this is the only reading of that schema that requires inventing nothing.
 */
export type CreateBookingInput = {
  serviceLines: CreateBookingServiceLineInput[];
  startAt: string;
  partySize?: number | undefined;
  travelAddress?: CreateBookingTravelAddressInput | undefined;
  customerCity?: BusinessCity | undefined;
  notes?: string | undefined;
  idempotencyKey: string;
};

export type CreateManualBookingInput = CreateBookingInput & {
  businessClientId: string;
};
