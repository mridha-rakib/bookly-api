import { model, Schema, type Types } from "mongoose";

import {
  type BusinessCity,
  type BusinessVisitType,
  businessCities,
  businessVisitTypes,
} from "../business/business.types.js";
import { type ClientPropertyType, clientPropertyTypes } from "../client/client.types.js";
import {
  type BookingActorRole,
  type BookingCurrency,
  type BookingEventType,
  type BookingServiceLinePricingMode,
  type BookingSource,
  type BookingStatus,
  bookingActorRoles,
  bookingCurrencies,
  bookingEventTypes,
  bookingServiceLinePricingModes,
  bookingSources,
  bookingStatuses,
  MAX_CUSTOMER_RESCHEDULE_COUNT,
} from "./booking.types.js";

// --- Actor / customer -------------------------------------------------------------------
//
// A Booking's "actual customer" (whose history/payment/cancellation/no-show lifecycle this
// Booking belongs to — confirmed rule) and its "creator" (who performed the action — confirmed
// rule D) are deliberately separate concepts:
//   - createdBy always identifies the acting User + their role at the time of creation.
//   - customer always identifies the BusinessClient row this Booking is for, which may or may
//     not be linked to a real Customer User account (Owner/Supervisor can book an unlinked
//     walk-in Client; only a real CUSTOMER self-booking guarantees a linked identity).
// customerUserId is a denormalized snapshot of BusinessClient.linkedUserId at booking time —
// purely a query-efficiency aid for a future "all of a Customer's bookings across every
// Business" list, never the source of truth for linkage (BusinessClient remains authoritative;
// see client-identity.service.ts).

export type BookingContactSnapshot = {
  firstName: string;
  lastName?: string | undefined;
  normalizedEmail: string;
  phone: {
    countryCode: string;
    nationalNumber: string;
    e164: string;
  };
};

export type BookingCustomer = {
  businessClientId: Types.ObjectId;
  customerUserId?: Types.ObjectId | undefined;
  contact: BookingContactSnapshot;
};

export type BookingActor = {
  actorUserId: Types.ObjectId;
  actorRole: BookingActorRole;
};

// --- Fulfilment / location snapshot -----------------------------------------------------
//
// A Business uses exactly one fulfilment mode (Business.visitType) — a Booking snapshots
// whichever location context applies at booking time so historical display never depends on a
// live Business/Client address that may since have changed (confirmed rule L). Exactly one of
// businessLocation/travelAddress is ever populated, matching `mode`; enforced in
// booking.service.ts (see BookingService.validateFulfilmentSnapshot), not here, matching this
// codebase's convention of keeping Mongoose to structural/type validation and cross-field
// consistency rules in the service layer (see Service's status-aware Zod rules for the same
// division of responsibility).

export type BookingLocationSnapshot = {
  city: BusinessCity;
  area: string;
  streetName: string;
  streetNumber: string;
  floorUnit?: string | undefined;
  aptRoom?: string | undefined;
};

export type BookingTravelAddressSnapshot = BookingLocationSnapshot & {
  propertyType: ClientPropertyType;
  additionalDirections?: string | undefined;
};

export type BookingFulfilment = {
  mode: BusinessVisitType;
  businessLocation?: BookingLocationSnapshot | undefined;
  travelAddress?: BookingTravelAddressSnapshot | undefined;
};

// --- Service lines -----------------------------------------------------------------------
//
// One Booking may contain multiple Service lines, each with its own responsible Staff member
// (confirmed rule F) — there is deliberately no booking-wide `staffId`. Each line snapshots the
// historical facts it needs (name, pricing mode, duration, discount, Add-on name/price) so a
// later Service/Add-on rename/reprice/archive can never corrupt what this Booking actually
// charged/represented (confirmed rule H), while still keeping a live `serviceId` reference for
// navigation/reporting. Snapshots capture facts, not whole Service documents.

export type BookingServiceLineAddon = {
  addonId: Types.ObjectId;
  name: string;
  /** Flat-fee snapshot in integer cents, matching Addon.priceCents's own convention. */
  priceCents: number;
};

export type BookingServiceLineServiceSnapshot = {
  name: string;
  pricingMode: BookingServiceLinePricingMode;
  durationMin: number;
  discountPercent?: number | undefined;
};

export type BookingServiceLineStaffSnapshot = {
  firstName: string;
  lastName?: string | undefined;
};

/**
 * The booked quantity each pricing mode actually needs (confirmed rule I): FIXED needs none;
 * HOURLY needs `hours`; PER_PERSON needs `personCount`; PACKAGE needs which session of the
 * purchased package this line represents. `packageProgressId` is reserved for the future
 * PackageProgress relationship (confirmed rule K) — deliberately not built as a real collection
 * in this phase; see booking.service.ts's module doc comment for the planned shape.
 */
export type BookingServiceLinePricingInput = {
  hours?: number | undefined;
  personCount?: number | undefined;
  sessionsInPackage?: number | undefined;
  sessionIndex?: number | undefined;
  packageProgressId?: Types.ObjectId | undefined;
};

export type BookingServiceLine = {
  serviceId: Types.ObjectId;
  serviceSnapshot: BookingServiceLineServiceSnapshot;
  pricingInput: BookingServiceLinePricingInput;
  /** Real StaffMembership (SUPERVISOR|STAFF) reference — the Business Owner is never eligible
   * (confirmed rule A/G); enforced in booking.service.ts, not structurally representable here
   * since StaffMembership itself never has an Owner row (see staff.model.ts). */
  responsibleStaffMembershipId: Types.ObjectId;
  staffSnapshot?: BookingServiceLineStaffSnapshot | undefined;
  addons: BookingServiceLineAddon[];
  /** Integer cents — this line's own amount, before Booking-level fees/discounts/travel. */
  amountCents: number;
};

// --- Financial snapshot ------------------------------------------------------------------
//
// Every amount is integer cents (matches the rest of the codebase's money convention). Bookly's
// first-booking platform fee (confirmed rule M) is `clamp(eligiblePlatformFeeBasisCents * 20%,
// €5, €35)`, where the basis excludes travelFeeCents by design — travelFeeCents is tracked
// separately and belongs to the Business/provider, never Bookly. A MANUAL Booking must always
// have platformFeeCents === 0 and depositCents === 0 (confirmed rule E) — enforced in
// booking.service.ts.

export type BookingFinancials = {
  currency: BookingCurrency;
  servicesSubtotalCents: number;
  addonsSubtotalCents: number;
  serviceDiscountCents: number;
  travelFeeCents: number;
  eligiblePlatformFeeBasisCents: number;
  platformFeeCents: number;
  depositCents: number;
  balanceDueCents: number;
  totalCents: number;
};

// --- Schedule (time architecture) ---------------------------------------------------------
//
// startAt/endAt are absolute instants (Mongo Date, UTC-backed) — never display strings like
// "10:00 AM" or "Tue 25 Aug". `timezone` snapshots the Business's IANA zone AT BOOKING TIME
// (see Business.timezone / common/time/timezone.ts) so a historical Booking stays correctly
// interpretable even if the Business's timezone setting changes later — the absolute
// timestamps alone are sufficient for ordering/conflict checks, but re-deriving a business-
// local display time from just the timestamps would silently use the *current* Business
// timezone without this snapshot. No creation flow populates these fields yet in this phase
// (Phase 2 is the availability/slot engine that computes them); the type/shape exists so that
// work has a stable target.

export type BookingSchedule = {
  timezone: string;
  startAt: Date;
  endAt: Date;
};

// --- Reschedule accounting -----------------------------------------------------------------
//
// customerRescheduleCount tracks ONLY successful CUSTOMER-initiated reschedules and is capped
// at MAX_CUSTOMER_RESCHEDULE_COUNT (confirmed rule O). rescheduleHistory records EVERY
// reschedule regardless of actor — an Owner/Supervisor operational reschedule is fully
// audited here but must never increment customerRescheduleCount, which is exactly what
// `countedTowardCustomerQuota` documents per-entry (true only when actorRole === "CUSTOMER").
// No reschedule endpoint exists in this phase; this is the accounting shape Phase 2/3's
// reschedule flow will write to.

export type BookingRescheduleEntry = {
  actorUserId: Types.ObjectId;
  actorRole: BookingActorRole;
  previousStart: Date;
  previousEnd: Date;
  newStart: Date;
  newEnd: Date;
  countedTowardCustomerQuota: boolean;
  createdAt: Date;
};

// --- Status / event history ------------------------------------------------------------------
//
// Auditable transition log (confirmed rule P) — deliberately never flattens cancellation/no-show
// outcomes into one generic status. No transition logic (the 90-minute no-show timer, financial
// side effects, etc.) is implemented in this phase; this is the storage shape for it.

export type BookingEventHistoryEntry = {
  type: BookingEventType;
  previousStatus?: BookingStatus | undefined;
  nextStatus?: BookingStatus | undefined;
  actorUserId: Types.ObjectId;
  actorRole: BookingActorRole;
  reason?: string | undefined;
  note?: string | undefined;
  createdAt: Date;
};

// --- Root ---------------------------------------------------------------------------------

export type BookingDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  /** Collision-safe, server-generated display reference (e.g. "BK-7F3K9QZC") — never
   * Math.random(); see booking.utils.ts generateBookingReference + the repository's
   * duplicate-key retry in booking.service.ts. Globally unique (not just per-Business) so a
   * Customer's cross-Business "My Bookings" view never shows two different Bookings sharing a
   * reference string. */
  reference: string;
  /** BOOKLY_MANAGED vs MANUAL (confirmed rule E) — every future financial code path must
   * branch on this before charging anything; Manual Bookings still fully occupy
   * Staff/calendar time and participate in conflict detection (Phase 2). */
  source: BookingSource;
  status: BookingStatus;
  customer: BookingCustomer;
  createdBy: BookingActor;
  fulfilment: BookingFulfilment;
  /** Never empty — a Booking with zero Service lines is not a Booking. */
  serviceLines: BookingServiceLine[];
  financials: BookingFinancials;
  schedule: BookingSchedule;
  customerRescheduleCount: number;
  rescheduleHistory: BookingRescheduleEntry[];
  eventHistory: BookingEventHistoryEntry[];
  notes?: string | undefined;
  // No hard-delete/archive path is modeled: a Booking is never removed once created — its
  // status changes, but the record (and every snapshot on it) persists indefinitely as the
  // historical source of truth for client history, payouts, and reviews (soft historical
  // integrity, confirmed rule H's spirit extended to the whole aggregate).
  createdAt: Date;
  updatedAt: Date;
};

// --- Mongoose schemas -----------------------------------------------------------------------

const bookingContactSnapshotSchema = new Schema<BookingContactSnapshot>(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, trim: true },
    normalizedEmail: { type: String, required: true, lowercase: true, trim: true },
    phone: {
      countryCode: { type: String, required: true },
      nationalNumber: { type: String, required: true },
      e164: { type: String, required: true },
    },
  },
  { _id: false },
);

const bookingCustomerSchema = new Schema<BookingCustomer>(
  {
    businessClientId: { type: Schema.Types.ObjectId, ref: "BusinessClient", required: true },
    customerUserId: { type: Schema.Types.ObjectId, ref: "User" },
    contact: { type: bookingContactSnapshotSchema, required: true },
  },
  { _id: false },
);

const bookingActorSchema = new Schema<BookingActor>(
  {
    actorUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    actorRole: { type: String, enum: bookingActorRoles, required: true },
  },
  { _id: false },
);

const bookingLocationSnapshotSchema = new Schema<BookingLocationSnapshot>(
  {
    city: { type: String, enum: businessCities, required: true },
    area: { type: String, required: true, trim: true },
    streetName: { type: String, required: true, trim: true },
    streetNumber: { type: String, required: true, trim: true },
    floorUnit: { type: String, trim: true },
    aptRoom: { type: String, trim: true },
  },
  { _id: false },
);

const bookingTravelAddressSnapshotSchema = new Schema<BookingTravelAddressSnapshot>(
  {
    city: { type: String, enum: businessCities, required: true },
    propertyType: { type: String, enum: clientPropertyTypes, required: true },
    area: { type: String, required: true, trim: true },
    streetName: { type: String, required: true, trim: true },
    streetNumber: { type: String, required: true, trim: true },
    floorUnit: { type: String, trim: true },
    aptRoom: { type: String, trim: true },
    additionalDirections: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false },
);

const bookingFulfilmentSchema = new Schema<BookingFulfilment>(
  {
    mode: { type: String, enum: businessVisitTypes, required: true },
    businessLocation: { type: bookingLocationSnapshotSchema },
    travelAddress: { type: bookingTravelAddressSnapshotSchema },
  },
  { _id: false },
);

const bookingServiceLineAddonSchema = new Schema<BookingServiceLineAddon>(
  {
    addonId: { type: Schema.Types.ObjectId, ref: "Addon", required: true },
    name: { type: String, required: true, trim: true },
    priceCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
  },
  { _id: false },
);

const bookingServiceLineServiceSnapshotSchema = new Schema<BookingServiceLineServiceSnapshot>(
  {
    name: { type: String, required: true, trim: true },
    pricingMode: { type: String, enum: bookingServiceLinePricingModes, required: true },
    durationMin: { type: Number, required: true, min: 1 },
    discountPercent: { type: Number, min: 0, max: 100 },
  },
  { _id: false },
);

const bookingServiceLineStaffSnapshotSchema = new Schema<BookingServiceLineStaffSnapshot>(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, trim: true },
  },
  { _id: false },
);

const bookingServiceLinePricingInputSchema = new Schema<BookingServiceLinePricingInput>(
  {
    hours: { type: Number, min: 0 },
    personCount: { type: Number, min: 1, validate: Number.isInteger },
    sessionsInPackage: { type: Number, min: 1, validate: Number.isInteger },
    sessionIndex: { type: Number, min: 1, validate: Number.isInteger },
    packageProgressId: { type: Schema.Types.ObjectId, ref: "PackageProgress" },
  },
  { _id: false },
);

/** True only when a line's pricingInput shape matches its own declared pricingMode (rule I). */
const pricingInputMatchesMode = (line: BookingServiceLine): boolean => {
  const input = line.pricingInput;
  const mode = line.serviceSnapshot.pricingMode;

  if (mode === "FIXED") {
    return (
      input.hours === undefined &&
      input.personCount === undefined &&
      input.sessionsInPackage === undefined &&
      input.sessionIndex === undefined
    );
  }

  if (mode === "HOURLY") {
    return (
      typeof input.hours === "number" &&
      input.hours > 0 &&
      input.personCount === undefined &&
      input.sessionsInPackage === undefined &&
      input.sessionIndex === undefined
    );
  }

  if (mode === "PER_PERSON") {
    return (
      typeof input.personCount === "number" &&
      input.personCount >= 1 &&
      input.hours === undefined &&
      input.sessionsInPackage === undefined &&
      input.sessionIndex === undefined
    );
  }

  // PACKAGE
  return (
    typeof input.sessionsInPackage === "number" &&
    input.sessionsInPackage >= 1 &&
    typeof input.sessionIndex === "number" &&
    input.sessionIndex >= 1 &&
    input.sessionIndex <= input.sessionsInPackage &&
    input.hours === undefined &&
    input.personCount === undefined
  );
};

const bookingServiceLineSchema = new Schema<BookingServiceLine>(
  {
    serviceId: { type: Schema.Types.ObjectId, ref: "Service", required: true },
    serviceSnapshot: { type: bookingServiceLineServiceSnapshotSchema, required: true },
    pricingInput: { type: bookingServiceLinePricingInputSchema, required: true, default: {} },
    responsibleStaffMembershipId: {
      type: Schema.Types.ObjectId,
      ref: "StaffMembership",
      required: true,
    },
    staffSnapshot: { type: bookingServiceLineStaffSnapshotSchema },
    addons: { type: [bookingServiceLineAddonSchema], required: true, default: [] },
    amountCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
  },
  { _id: false },
);

const bookingFinancialsSchema = new Schema<BookingFinancials>(
  {
    currency: { type: String, enum: bookingCurrencies, required: true, default: "EUR" },
    servicesSubtotalCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    addonsSubtotalCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    serviceDiscountCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    travelFeeCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    eligiblePlatformFeeBasisCents: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isInteger,
    },
    platformFeeCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    depositCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    balanceDueCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    totalCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
  },
  { _id: false },
);

const bookingScheduleSchema = new Schema<BookingSchedule>(
  {
    timezone: { type: String, required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
  },
  { _id: false },
);

const bookingRescheduleEntrySchema = new Schema<BookingRescheduleEntry>(
  {
    actorUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    actorRole: { type: String, enum: bookingActorRoles, required: true },
    previousStart: { type: Date, required: true },
    previousEnd: { type: Date, required: true },
    newStart: { type: Date, required: true },
    newEnd: { type: Date, required: true },
    countedTowardCustomerQuota: { type: Boolean, required: true },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

const bookingEventHistoryEntrySchema = new Schema<BookingEventHistoryEntry>(
  {
    type: { type: String, enum: bookingEventTypes, required: true },
    previousStatus: { type: String, enum: bookingStatuses },
    nextStatus: { type: String, enum: bookingStatuses },
    actorUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    actorRole: { type: String, enum: bookingActorRoles, required: true },
    reason: { type: String, trim: true, maxlength: 500 },
    note: { type: String, trim: true, maxlength: 2000 },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

const bookingSchema = new Schema<BookingDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    reference: { type: String, required: true, trim: true, uppercase: true },
    source: { type: String, enum: bookingSources, required: true, default: "BOOKLY_MANAGED" },
    status: { type: String, enum: bookingStatuses, required: true, default: "UPCOMING" },
    customer: { type: bookingCustomerSchema, required: true },
    createdBy: { type: bookingActorSchema, required: true },
    fulfilment: { type: bookingFulfilmentSchema, required: true },
    serviceLines: {
      type: [bookingServiceLineSchema],
      required: true,
      validate: {
        validator: (lines: BookingServiceLine[]) =>
          lines.length > 0 && lines.every((line) => pricingInputMatchesMode(line)),
        message:
          "A Booking must have at least one Service line, and each line's pricing input must match its pricing mode",
      },
    },
    financials: { type: bookingFinancialsSchema, required: true },
    schedule: { type: bookingScheduleSchema, required: true },
    customerRescheduleCount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      max: MAX_CUSTOMER_RESCHEDULE_COUNT,
      validate: Number.isInteger,
    },
    rescheduleHistory: { type: [bookingRescheduleEntrySchema], required: true, default: [] },
    eventHistory: { type: [bookingEventHistoryEntrySchema], required: true, default: [] },
    notes: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true },
);

// Booking reference is the human-facing identifier and must never collide across the whole
// platform (a Customer's cross-Business "My Bookings" view could otherwise show two different
// Bookings sharing a reference) — this is also the backstop the reference-generation retry loop
// in booking.service.ts relies on (duplicate-key catch, matching this codebase's established
// concurrency convention rather than a fabricated "unique interval" index — see report).
bookingSchema.index({ reference: 1 }, { unique: true });
// Business's own bookings by date range — the Calendar / All Bookings / Upcoming query.
bookingSchema.index({ businessId: 1, "schedule.startAt": 1 });
// Status-filtered lists within a Business (Upcoming/Canceled/etc tabs).
bookingSchema.index({ businessId: 1, status: 1 });
// A specific Staff member's bookings by time range — the future per-Staff conflict/availability
// query. One array field (serviceLines) participates, which MongoDB fully supports in a
// compound index (at most one array path per compound index — this index has exactly one).
bookingSchema.index({ "serviceLines.responsibleStaffMembershipId": 1, "schedule.startAt": 1 });
// A BusinessClient's booking history within one Business (Client Details "All bookings").
bookingSchema.index({ "customer.businessClientId": 1, "schedule.startAt": -1 });
// A linked Customer's own bookings across every Business ("My Bookings") — sparse because
// customerUserId is only ever set when the BusinessClient is linked to a real Customer account.
bookingSchema.index({ "customer.customerUserId": 1, "schedule.startAt": -1 }, { sparse: true });

export const BookingModel = model<BookingDocument>("Booking", bookingSchema);
