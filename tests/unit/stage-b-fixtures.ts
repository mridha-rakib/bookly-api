import { Types } from "mongoose";

import type { BookingDocument } from "../../src/modules/booking/booking.model.js";
import type { BusinessDocument } from "../../src/modules/business/business.model.js";

/** Shared minimal fixtures for Stage-B notifier/template tests. */

export const buildBusiness = (overrides: Partial<BusinessDocument> = {}): BusinessDocument =>
  ({
    _id: new Types.ObjectId(),
    ownerUserId: new Types.ObjectId(),
    name: "Soho Vintage Barbers",
    ownerName: "Blake Owner",
    email: "owner@example.com",
    timezone: "Europe/Nicosia",
    status: "APPROVED",
    visitType: "AT_BUSINESS_LOCATION",
    address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
    briefDescription: "A great barbershop",
    category: "Wellness",
    subcategories: ["Barber"],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  }) as BusinessDocument;

export const buildBooking = (overrides: Partial<BookingDocument> = {}): BookingDocument => {
  const startAt = new Date("2026-09-05T09:00:00.000Z");
  const endAt = new Date("2026-09-05T09:45:00.000Z");
  return {
    _id: new Types.ObjectId(),
    businessId: new Types.ObjectId(),
    reference: "BK-7F3K9QZC",
    source: "BOOKLY_MANAGED",
    status: "UPCOMING",
    customer: {
      businessClientId: new Types.ObjectId(),
      customerUserId: new Types.ObjectId(),
      contact: {
        firstName: "Dana",
        lastName: "Klein",
        normalizedEmail: "dana@example.com",
        phone: { countryCode: "+357", nationalNumber: "99000111", e164: "+35799000111" },
      },
    },
    createdBy: { actorUserId: new Types.ObjectId(), actorRole: "CUSTOMER" },
    fulfilment: {
      mode: "AT_BUSINESS_LOCATION",
      businessLocation: {
        city: "Larnaca",
        area: "Center",
        streetName: "Main",
        streetNumber: "1",
      },
    },
    serviceLines: [
      {
        serviceId: new Types.ObjectId(),
        serviceSnapshot: { name: "Haircut", pricingMode: "FIXED", durationMin: 45 },
        pricingInput: {},
        responsibleStaffMembershipId: new Types.ObjectId(),
        staffSnapshot: { firstName: "Sam", lastName: "Cutter" },
        addons: [{ addonId: new Types.ObjectId(), name: "Beard trim", priceCents: 500 }],
        amountCents: 3000,
        reservationId: new Types.ObjectId(),
      },
    ],
    financials: {
      currency: "EUR",
      servicesSubtotalCents: 3000,
      addonsSubtotalCents: 500,
      serviceDiscountCents: 0,
      travelFeeCents: 0,
      eligiblePlatformFeeBasisCents: 3500,
      platformFeeCents: 700,
      depositCents: 700,
      balanceDueCents: 2800,
      totalCents: 3500,
    },
    schedule: { timezone: "Europe/Nicosia", startAt, endAt },
    customerRescheduleCount: 0,
    rescheduleHistory: [],
    eventHistory: [],
    cancellationPolicySnapshot: {
      tiers: [{ tier: "MORE_THAN_72H", mode: "FREE" }],
      noShowPercentage: 30,
    },
    createdAt: startAt,
    updatedAt: startAt,
    ...overrides,
  } as unknown as BookingDocument;
};
