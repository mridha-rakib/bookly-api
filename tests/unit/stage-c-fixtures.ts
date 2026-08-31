import { Types } from "mongoose";

import type { BookingDocument } from "../../src/modules/booking/booking.model.js";
import type { InvoiceData } from "../../src/modules/email/templates/invoice/invoice-data.js";
import { buildBooking } from "./stage-b-fixtures.js";

export { buildBooking, buildBusiness } from "./stage-b-fixtures.js";

/**
 * A completed booking. Base (from Stage B fixture): total €35.00, deposit €7.00,
 * balanceDue €28.00. Pass a `completionPayment` override to exercise FULL / PARTIAL / NOT_PAID.
 */
export const buildCompletedBooking = (overrides: Partial<BookingDocument> = {}): BookingDocument =>
  buildBooking({
    status: "COMPLETED",
    updatedAt: new Date("2026-09-05T10:30:00.000Z"),
    completionPayment: {
      paid: true,
      amountCents: 2800,
      recordedAt: new Date("2026-09-05T10:30:00.000Z"),
      recordedBy: new Types.ObjectId(),
    } as never,
    ...overrides,
  });

export const buildInvoiceDataFixture = (over: Partial<InvoiceData> = {}): InvoiceData => ({
  bookingReference: "BK-7F3K9QZC",
  invoiceReference: "BK-7F3K9QZC",
  issuedAtIso: "2026-09-05T10:30:00.000Z",
  issuedAtFormatted: "Saturday, 5 September 2026",
  business: {
    name: "Soho Vintage Barbers",
    phone: "+35799000111",
    address: "1 Main, Center, Larnaca",
  },
  customer: { name: "Dana Klein", firstName: "Dana", email: "dana@example.com" },
  appointment: {
    startAtIso: "2026-09-05T06:00:00.000Z",
    timezone: "Europe/Nicosia",
    dateFormatted: "Saturday, 5 September 2026",
    timeFormatted: "09:00",
    durationMin: 45,
  },
  lineItems: [
    { label: "Haircut", kind: "SERVICE", amountFormatted: "€30.00" },
    { label: "Beard trim", kind: "ADDON", amountFormatted: "€5.00" },
  ],
  financial: {
    currency: "EUR",
    servicesSubtotalFormatted: "€30.00",
    addonsSubtotalFormatted: "€5.00",
    serviceDiscountFormatted: "€0.00",
    promoDiscountFormatted: "€0.00",
    travelFeeFormatted: "€0.00",
    totalFormatted: "€35.00",
    upfrontPaidFormatted: "€7.00",
    venuePaymentFormatted: "€28.00",
    totalPaidFormatted: "€35.00",
    outstandingFormatted: "€0.00",
    settlementStatus: "FULL",
    settlementLabel: "Paid in full",
    show: {
      addons: true,
      serviceDiscount: false,
      promoDiscount: false,
      travelFee: false,
      venuePayment: true,
      outstanding: false,
    },
    ...over.financial,
  },
  ...over,
});
