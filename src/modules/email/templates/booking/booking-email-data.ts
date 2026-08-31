import type { BookingDocument } from "../../../booking/booking.model.js";
import {
  durationMinutesBetween,
  formatDateInTimezone,
  formatMoney,
  formatTimeInTimezone,
} from "../components/email-format.js";

/**
 * The typed, JSON-safe payload every Stage-B booking email template renders from. Built ONCE at
 * enqueue time (in the notification layer) straight from the committed Booking's own persisted
 * snapshots + the Business name; stored on the outbox row; handed to the pure template renderer
 * by the worker. Templates never see a Mongoose document, never query a repository, and never
 * do money arithmetic — every amount here is copied verbatim from `booking.financials` /
 * `booking.serviceLines[].amountCents` / `booking.promo`.
 */
export type BookingEmailServiceLine = {
  name: string;
  durationMin: number;
  staffName?: string;
  amountFormatted: string;
  addons: Array<{ name: string; priceFormatted: string }>;
};

export type BookingEmailData = {
  reference: string;
  businessName: string;
  customerName: string;
  /** Who actually created the booking — drives per-template wording, never fabricated. */
  createdByRole: "CUSTOMER" | "BUSINESS_OWNER" | "SUPERVISOR";
  source: "BOOKLY_MANAGED" | "MANUAL";
  appointmentDate: string;
  appointmentTime: string;
  durationMin: number;
  fulfilment:
    | { kind: "AT_BUSINESS_LOCATION"; address: string }
    | { kind: "TRAVEL_TO_CUSTOMER"; address: string }
    | { kind: "AT_BUSINESS_LOCATION"; address: null }
    | { kind: "TRAVEL_TO_CUSTOMER"; address: null };
  serviceLines: BookingEmailServiceLine[];
  currency: string;
  money: {
    servicesSubtotalFormatted: string;
    addonsSubtotalFormatted: string;
    serviceDiscountFormatted: string;
    travelFeeFormatted: string;
    totalFormatted: string;
    /** Amount actually taken online now — `promo.chargeCents` when a promo applied, else
     * `financials.depositCents`. A field selection, not a calculation. 0 for MANUAL. */
    paidNowFormatted: string;
    /** `financials.balanceDueCents` verbatim — payable at the venue. */
    balanceDueFormatted: string;
    hasServiceDiscount: boolean;
    hasTravelFee: boolean;
    hasAddons: boolean;
  };
  /** Present only when the Booking actually carries a cancellation policy snapshot. */
  cancellationPolicy?: {
    noShowPercentage: number;
  };
  /** `/customer/bookings/view?id=<id>` — included only when the recipient has a customer account
   * (the Booking's customer is a LINKED Customer user). */
  customerBookingUrlPath?: string;
};

export const formatFulfilmentAddress = (booking: BookingDocument): string | null => {
  const parts = (
    booking.fulfilment.mode === "TRAVEL_TO_CUSTOMER"
      ? booking.fulfilment.travelAddress
      : booking.fulfilment.businessLocation
  ) as { area?: string; streetName?: string; streetNumber?: string; city?: string } | undefined;
  if (!parts) {
    return null;
  }
  const line = [parts.streetNumber, parts.streetName].filter(Boolean).join(" ");
  return [line, parts.area, parts.city].filter(Boolean).join(", ") || null;
};

export const buildBookingEmailData = (
  booking: BookingDocument,
  context: { businessName: string; includeCustomerBookingLink: boolean },
): BookingEmailData => {
  const tz = booking.schedule.timezone;
  const currency = booking.financials.currency;

  const serviceLines: BookingEmailServiceLine[] = booking.serviceLines.map((line) => ({
    name: line.serviceSnapshot.name,
    durationMin: line.serviceSnapshot.durationMin,
    ...(line.staffSnapshot
      ? {
          staffName: [line.staffSnapshot.firstName, line.staffSnapshot.lastName]
            .filter(Boolean)
            .join(" "),
        }
      : {}),
    amountFormatted: formatMoney(line.amountCents, currency),
    addons: line.addons.map((addon) => ({
      name: addon.name,
      priceFormatted: formatMoney(addon.priceCents, currency),
    })),
  }));

  // Field selection from persisted values — NOT a computation.
  const paidNowCents = booking.promo ? booking.promo.chargeCents : booking.financials.depositCents;

  const address = formatFulfilmentAddress(booking);

  return {
    reference: booking.reference,
    businessName: context.businessName,
    customerName: booking.customer.contact.firstName,
    createdByRole: booking.createdBy.actorRole as BookingEmailData["createdByRole"],
    source: booking.source as BookingEmailData["source"],
    appointmentDate: formatDateInTimezone(booking.schedule.startAt, tz),
    appointmentTime: formatTimeInTimezone(booking.schedule.startAt, tz),
    durationMin: durationMinutesBetween(booking.schedule.startAt, booking.schedule.endAt),
    fulfilment: {
      kind: booking.fulfilment.mode as "AT_BUSINESS_LOCATION" | "TRAVEL_TO_CUSTOMER",
      address,
    } as BookingEmailData["fulfilment"],
    serviceLines,
    currency,
    money: {
      servicesSubtotalFormatted: formatMoney(booking.financials.servicesSubtotalCents, currency),
      addonsSubtotalFormatted: formatMoney(booking.financials.addonsSubtotalCents, currency),
      serviceDiscountFormatted: formatMoney(booking.financials.serviceDiscountCents, currency),
      travelFeeFormatted: formatMoney(booking.financials.travelFeeCents, currency),
      totalFormatted: formatMoney(booking.financials.totalCents, currency),
      paidNowFormatted: formatMoney(paidNowCents, currency),
      balanceDueFormatted: formatMoney(booking.financials.balanceDueCents, currency),
      hasServiceDiscount: booking.financials.serviceDiscountCents > 0,
      hasTravelFee: booking.financials.travelFeeCents > 0,
      hasAddons: booking.financials.addonsSubtotalCents > 0,
    },
    ...(booking.cancellationPolicySnapshot
      ? {
          cancellationPolicy: {
            noShowPercentage: booking.cancellationPolicySnapshot.noShowPercentage,
          },
        }
      : {}),
    ...(context.includeCustomerBookingLink && booking.customer.customerUserId
      ? { customerBookingUrlPath: `/customer/bookings/view?id=${String(booking._id)}` }
      : {}),
  };
};
