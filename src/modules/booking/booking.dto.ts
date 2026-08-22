import type { BookingDocument } from "./booking.model.js";

/**
 * Explicit response DTOs (item 12/13) — a controller must never serialize a raw Mongoose
 * BookingDocument. `notes`/internal metadata beyond what a viewer legitimately needs are
 * dropped; list/calendar DTOs additionally drop eventHistory/rescheduleHistory (unbounded-
 * growth arrays a list view never needs — the repository's own projection already excludes them
 * for list/calendar reads, this mapper just doesn't reference them either way).
 *
 * ONE shared shape serves both the Business-side and Customer-side detail read: both viewers are
 * legitimately authorized to see every fact about a Booking they can already reach (the Business
 * that owns it, or the Customer it belongs to) — there is no confirmed field that must be hidden
 * from one but not the other, so building two divergent DTOs would be speculative.
 */

export type BookingServiceLineDto = {
  serviceId: string;
  name: string;
  pricingMode: string;
  durationMin: number;
  discountPercent?: number | undefined;
  staffMembershipId: string;
  staffName?: string | undefined;
  addons: Array<{ addonId: string; name: string; priceCents: number }>;
  amountCents: number;
};

export type BookingDetailDto = {
  id: string;
  businessId: string;
  reference: string;
  source: string;
  status: string;
  customer: {
    businessClientId: string;
    firstName: string;
    lastName?: string | undefined;
    email: string;
    phone: { countryCode: string; nationalNumber: string; e164: string };
  };
  createdBy: { actorRole: string };
  fulfilment: BookingDocument["fulfilment"];
  serviceLines: BookingServiceLineDto[];
  financials: BookingDocument["financials"];
  schedule: { timezone: string; startAt: string; endAt: string };
  customerRescheduleCount: number;
  cancellationOutcome?: BookingDocument["cancellationOutcome"];
  completionPayment?: { paid: boolean; amountCents?: number; recordedAt: string } | undefined;
  /** Batch 6 — both writable ONLY by BookingLifecycleService.markNoShow, both-or-neither (see
   * the model's own pre-validate hook). Lets the frontend derive a real countdown from the
   * backend's own authoritative deadline instead of a client-side timer with no source of
   * truth (confirmed rule: "the frontend countdown must derive from backend deadline"). */
  noShowStartedAt?: string | undefined;
  noShowDeadlineAt?: string | undefined;
  notes?: string | undefined;
  createdAt: string;
  updatedAt: string;
};

export type BookingListItemDto = {
  id: string;
  reference: string;
  status: string;
  source: string;
  primaryServiceName: string;
  serviceCount: number;
  customerName: string;
  businessClientId: string;
  staffNames: string[];
  schedule: { timezone: string; startAt: string; endAt: string };
  totalCents: number;
  depositCents: number;
  currency: string;
  /** First-vs-returning display only (Batch 6, item 17) — never a second source of truth for
   * money: for a BOOKLY_MANAGED booking, `platformFeeCents > 0` means this WAS the customer's
   * first booking at this business (see booking-creation.service.ts's own
   * `depositCents = ... : platformFeeCents` — a first booking is the only case this is ever
   * nonzero); 0 means returning. Meaningless for `source: "MANUAL"` (always 0) — the frontend
   * must branch on `source` first, exactly like every other MANUAL-vs-BOOKLY_MANAGED display
   * rule in this codebase. */
  platformFeeCents: number;
};

export type BookingCalendarEntryDto = {
  id: string;
  reference: string;
  status: string;
  source: string;
  schedule: { timezone: string; startAt: string; endAt: string };
  serviceNames: string[];
  staffMembershipIds: string[];
  staffNames: string[];
  customerName: string;
  totalCents: number;
  currency: string;
};

const toServiceLineDto = (
  line: BookingDocument["serviceLines"][number],
): BookingServiceLineDto => ({
  serviceId: String(line.serviceId),
  name: line.serviceSnapshot.name,
  pricingMode: line.serviceSnapshot.pricingMode,
  durationMin: line.serviceSnapshot.durationMin,
  discountPercent: line.serviceSnapshot.discountPercent,
  staffMembershipId: String(line.responsibleStaffMembershipId),
  staffName: line.staffSnapshot
    ? [line.staffSnapshot.firstName, line.staffSnapshot.lastName].filter(Boolean).join(" ")
    : undefined,
  addons: line.addons.map((addon) => ({
    addonId: String(addon.addonId),
    name: addon.name,
    priceCents: addon.priceCents,
  })),
  amountCents: line.amountCents,
});

/** Deduped, presence-ordered display names across a Booking's service lines — a list/calendar
 * row needs a compact "who" summary without pulling the full per-line staffSnapshot detail the
 * detail DTO already provides via serviceLines. */
const staffNamesForBooking = (booking: BookingDocument): string[] => {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const line of booking.serviceLines) {
    if (!line.staffSnapshot) continue;
    const name = [line.staffSnapshot.firstName, line.staffSnapshot.lastName]
      .filter(Boolean)
      .join(" ");
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
};

export const toBookingDetailDto = (booking: BookingDocument): BookingDetailDto => ({
  id: String(booking._id),
  businessId: String(booking.businessId),
  reference: booking.reference,
  source: booking.source,
  status: booking.status,
  customer: {
    businessClientId: String(booking.customer.businessClientId),
    firstName: booking.customer.contact.firstName,
    lastName: booking.customer.contact.lastName,
    email: booking.customer.contact.normalizedEmail,
    phone: booking.customer.contact.phone,
  },
  createdBy: { actorRole: booking.createdBy.actorRole },
  fulfilment: booking.fulfilment,
  serviceLines: booking.serviceLines.map(toServiceLineDto),
  financials: booking.financials,
  schedule: {
    timezone: booking.schedule.timezone,
    startAt: booking.schedule.startAt.toISOString(),
    endAt: booking.schedule.endAt.toISOString(),
  },
  customerRescheduleCount: booking.customerRescheduleCount,
  cancellationOutcome: booking.cancellationOutcome,
  completionPayment: booking.completionPayment
    ? {
        paid: booking.completionPayment.paid,
        ...(booking.completionPayment.amountCents !== undefined
          ? { amountCents: booking.completionPayment.amountCents }
          : {}),
        recordedAt: booking.completionPayment.recordedAt.toISOString(),
      }
    : undefined,
  noShowStartedAt: booking.noShowStartedAt?.toISOString(),
  noShowDeadlineAt: booking.noShowDeadlineAt?.toISOString(),
  notes: booking.notes,
  createdAt: booking.createdAt.toISOString(),
  updatedAt: booking.updatedAt.toISOString(),
});

export const toBookingListItemDto = (booking: BookingDocument): BookingListItemDto => ({
  id: String(booking._id),
  reference: booking.reference,
  status: booking.status,
  source: booking.source,
  primaryServiceName: booking.serviceLines[0]?.serviceSnapshot.name ?? "",
  serviceCount: booking.serviceLines.length,
  customerName: [booking.customer.contact.firstName, booking.customer.contact.lastName]
    .filter(Boolean)
    .join(" "),
  businessClientId: String(booking.customer.businessClientId),
  staffNames: staffNamesForBooking(booking),
  schedule: {
    timezone: booking.schedule.timezone,
    startAt: booking.schedule.startAt.toISOString(),
    endAt: booking.schedule.endAt.toISOString(),
  },
  totalCents: booking.financials.totalCents,
  depositCents: booking.financials.depositCents,
  currency: booking.financials.currency,
  platformFeeCents: booking.financials.platformFeeCents,
});

export const toBookingCalendarEntryDto = (booking: BookingDocument): BookingCalendarEntryDto => ({
  id: String(booking._id),
  reference: booking.reference,
  status: booking.status,
  source: booking.source,
  schedule: {
    timezone: booking.schedule.timezone,
    startAt: booking.schedule.startAt.toISOString(),
    endAt: booking.schedule.endAt.toISOString(),
  },
  serviceNames: booking.serviceLines.map((line) => line.serviceSnapshot.name),
  staffMembershipIds: booking.serviceLines.map((line) => String(line.responsibleStaffMembershipId)),
  staffNames: staffNamesForBooking(booking),
  customerName: [booking.customer.contact.firstName, booking.customer.contact.lastName]
    .filter(Boolean)
    .join(" "),
  totalCents: booking.financials.totalCents,
  currency: booking.financials.currency,
});
