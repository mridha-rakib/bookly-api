import { model, Schema, type Types } from "mongoose";

import {
  type BusinessCity,
  type BusinessVisitType,
  businessCities,
  businessVisitTypes,
} from "../business/business.types.js";
import {
  CANCELLATION_PERCENTAGE_MAX,
  CANCELLATION_PERCENTAGE_MIN,
  type CancellationFeeMode,
  type CancellationTier,
  cancellationFeeModes,
  cancellationTiers,
} from "../business-cancellation-policy/business-cancellation-policy.model.js";
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
  DEPOSIT_MAX_CENTS,
  DEPOSIT_MIN_CENTS,
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
  /**
   * The BookingSlotReservation interval this line's occupancy claim lives in (Batch 3) — one
   * per distinct responsible Staff member across the Booking's service lines, all sharing the
   * Booking's single root `schedule` window (see BookingSchedule's own comment: this schema has
   * no per-line timing, so a multi-line Booking's lines are modeled as happening in parallel
   * during the same [startAt, endAt), each with its own Staff member and hence its own
   * reservation — never a second, invented per-line timing model). Required from Batch 3
   * onward: every real creation path reserves before it persists.
   */
  reservationId: Types.ObjectId;
};

// --- Financial snapshot ------------------------------------------------------------------
//
// Every amount is integer cents (matches the rest of the codebase's money convention).
//
// BATCH 6.5 — DEPOSIT vs PLATFORM FEE (critical correction; do not conflate these again):
//
//   depositCents      = calculateBookingDepositCents(eligiblePlatformFeeBasisCents)
//                      = clamp(eligiblePlatformFeeBasisCents * 20%, €5, €35)
//                      — charged online for EVERY BOOKLY_MANAGED booking, first OR returning.
//   platformFeeCents  = isFirstBooking ? depositCents : 0
//                      — Bookly's own share of that SAME deposit. Nonzero ONLY on the
//                        customer's first eligible booking at this specific Business (see
//                        BusinessClient.activatedAt) — a first booking's deposit IS the
//                        platform fee (they happen to be numerically equal), never a second,
//                        independently-invented figure.
//
// So: depositCents is ALWAYS the amount the customer actually pays online (subject to real
// booking economics; 0 only for MANUAL). platformFeeCents is Bookly's economic CLAIM on that
// deposit, which is 0 for a returning customer's booking — in that case the customer still
// pays depositCents online, but it belongs to the Business (an already-collected service
// prepayment), never to Bookly. NEVER use platformFeeCents as a proxy for "how much did the
// customer pay" (that is always depositCents) or use "returning" to mean "no deposit required"
// (a returning customer still pays a deposit — only WHO economically keeps it changes). The
// basis excludes travelFeeCents by design — travelFeeCents is tracked separately and belongs to
// the Business/provider, never Bookly. A MANUAL Booking must always have platformFeeCents === 0
// and depositCents === 0 (confirmed rule E) — enforced in booking.service.ts.

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

// --- Promo Code snapshot (Batch 13) --------------------------------------------------------
//
// A Promo Code discounts ONLY the already-computed online booking-time charge
// (BookingFinancials.depositCents) — it never rewrites Service pricing, `serviceDiscountCents`,
// `eligiblePlatformFeeBasisCents`, or `totalCents`/`balanceDueCents`. `depositCents` above
// therefore STAYS the full pre-promo canonical entitlement (what the Business/Bookly is
// economically owed); this snapshot records only the ADDITIONAL promo facts needed to explain
// why the actual Stripe charge (and the ledger's DEBIT entry amount — see
// booking-creation.service.ts) was lower. Present only when a promo was actually applied —
// absent, never a zero-value object, for every other Booking (additive, matches every other
// optional snapshot on this model). Denormalizes code/type/value at application time (never a
// live PromoCode lookup) so a later Promo edit/deactivation can never corrupt this Booking's own
// history — the SAME immutable-snapshot discipline `serviceSnapshot` already established.
export type BookingPromoSnapshot = {
  promoId: Types.ObjectId;
  code: string;
  type: "PERCENTAGE" | "FIXED";
  value: number;
  discountCents: number;
  /** What was actually charged online: `financials.depositCents - discountCents`, clamped at 0.
   * This is ALSO the amount the ledger's PLATFORM_FEE/DEPOSIT entry records (see
   * booking-creation.service.ts) — everything downstream (cancellation/no-show netting, refunds)
   * already reads from that real ledger amount, never from this field directly. */
  chargeCents: number;
  fundingOwner: "BOOKLY";
  appliedAt: Date;
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

// --- Cancellation policy snapshot / outcome (Batch 3) -----------------------------------------
//
// Historical-integrity requirement: a Booking's cancellation classification must never depend on
// the LIVE BusinessCancellationPolicy, since a Business may edit that policy after this Booking
// was created — doing so must never retroactively change what an already-placed Booking owes on
// cancellation. `cancellationPolicySnapshot` copies exactly the two fact fields the policy
// document holds (tiers + noShowPercentage — see business-cancellation-policy.model.ts) at
// Booking-creation time; it is absent only when the Business had no policy configured at all at
// that moment (matches this codebase's "missing configuration" convention elsewhere — see
// BusinessOpeningHours — where a missing document means "not configured", not a fabricated
// default). `cancellationOutcome` is populated once, only by an actual cancellation action, and
// records the classification actually applied — never recomputed from a later policy edit.

export type BookingCancellationPolicySnapshot = {
  tiers: Array<{ tier: CancellationTier; mode: CancellationFeeMode; percentage?: number }>;
  noShowPercentage: number;
};

/**
 * `cancellationFeeCents`/`refundOwedCents` are the CLASSIFIED amounts (what the policy says is
 * owed/refundable) — never proof that money actually moved. `settlementStatus` is the honest,
 * separately-tracked record of whether the associated Stripe charge/refund actually succeeded
 * (Batch 4: "Do not conflate booking lifecycle status with payment settlement status" — the
 * Booking's own `status` transitions to CANCELLED_BY_CUSTOMER/LATE_CANCELLATION/
 * CANCELLED_BY_BUSINESS regardless of settlement outcome, since the appointment IS cancelled
 * and the slot IS released either way; only this field says whether the money side is done,
 * still pending, or failed). `settlementProviderReference` is the Stripe PaymentIntent/Refund id
 * once known, for audit/reconciliation — cross-referenced against the immutable
 * BookingFinancialTransaction ledger entry, which remains the authoritative money record; this
 * field is a fast-read convenience, never a second source of truth.
 *
 * Batch 5 correction: `depositAppliedCents`/`additionalChargeCents` net the classified
 * `cancellationFeeCents` against the deposit ALREADY collected at booking time
 * (`Booking.financials.depositCents` — see BookingFinancials's own doc comment). Evidence: the
 * approved customer-facing reference screenshots (docs/figma-booking-reference) and this same
 * repo's own pre-existing customer/bookings mock data both consistently show a
 * late-cancellation/no-show fee being paid FROM the already-collected deposit first, with only
 * the shortfall ever newly charged — e.g. a €80 booking with a €16 deposit and a 50%-tier €40
 * fee shows "€16 retained, €24 additionally charged, €40 total", never a fresh €40 charge on top
 * of the already-held €16. The deposit itself is never refunded back to the customer on a
 * customer-initiated cancellation/no-show, REGARDLESS of whether it is Bookly's own activation
 * revenue (first booking) or the Business's already-collected service prepayment (returning
 * booking, Batch 6.5) — same non-refundable-to-customer rule Batch 4 already established for a
 * >72h free cancellation — `refundOwedCents` therefore stays 0 for every CUSTOMER-initiated
 * path; it is populated only by the BUSINESS-cancellation caller
 * (BookingLifecycleService.cancelByBusiness), which refunds the FULL deposit (whichever party
 * economically owned it) since a business-caused cancellation is never the customer's fault
 * (unchanged from Batch 4).
 *   depositAppliedCents = min(cancellationFeeCents, depositAlreadyPaidCents)  — informational
 *   additionalChargeCents = max(0, cancellationFeeCents - depositAlreadyPaidCents) — the actual
 *     amount a NEW Stripe charge collects; this, not the gross `cancellationFeeCents`, is what
 *     executeCancellationFeeCharge/NoShowResolutionService/waiveFee all charge or waive.
 */
export type BookingCancellationOutcome = {
  classifiedAt: Date;
  tier: CancellationTier;
  feeMode: CancellationFeeMode;
  feePercentage?: number | undefined;
  cancellationFeeCents: number;
  depositAppliedCents: number;
  additionalChargeCents: number;
  refundOwedCents: number;
  settlementStatus: "NOT_APPLICABLE" | "PENDING" | "SUCCEEDED" | "FAILED" | "WAIVED";
  settlementProviderReference?: string | undefined;
};

/**
 * Written ONCE, only by `BookingLifecycleService.completeBooking`, when the Business explicitly
 * attests whether the customer paid the remaining `financials.balanceDueCents` at the venue
 * (confirmed via the business-owner "Complete Booking" reference screenshot — see
 * docs/figma-booking-reference/business-owner/complete.png, not previously implemented). This is
 * a Business self-attestation about money collected OFF-platform (cash/card-in-person, exactly
 * like a MANUAL Booking's financials are already entirely business-attested) — Bookly has no way
 * to independently verify it, so `amountCents` is the one legitimate exception to "never trust
 * client-supplied financial values": it is never used to compute Bookly's own fee/deposit/ledger
 * PLATFORM_FEE entries, only to record a `PAYMENT` ledger entry (see completeBooking) for
 * reporting/reconciliation. Absent entirely when the Business's completion action didn't record
 * a venue-payment answer (e.g. no balance was ever due, or an older/manual completion path).
 */
export type BookingCompletionPayment = {
  paid: boolean;
  amountCents?: number | undefined;
  note?: string | undefined;
  recordedAt: Date;
  recordedBy: Types.ObjectId;
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
  /** Google Calendar event id for this Booking's one-way sync (see integration/ module).
   * Present only while a synced event exists — cleared once the event is deleted (booking
   * cancelled) so idempotent re-sync attempts don't leak/duplicate events. */
  googleCalendarEventId?: string | undefined;
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
  /**
   * No-show never starts automatically — both fields are set together, only by an explicit
   * business-side "mark as no-show" action (not implemented in this phase), never by a
   * timer/cron reacting to a missed appointment on its own. noShowDeadlineAt is always
   * noShowStartedAt + NO_SHOW_RESOLUTION_WINDOW_MINUTES (booking.types.ts), computed by that
   * future action, not derived implicitly here. A future background worker resolves any
   * Booking still `status: "PENDING"` past its noShowDeadlineAt (charge/waive/cancel);
   * resolving moves `status` away from "PENDING" to one of NO_SHOW_CHARGED/NO_SHOW_WAIVED/
   * NO_SHOW_CANCELLED, which is itself the resolution record — no separate
   * noShowResolvedAt/noShowResolution field is modeled, since `status` (with eventHistory for
   * the audit trail of who/when) already captures that unambiguously. See the
   * `{status, noShowDeadlineAt}` index below, sized for exactly that worker's query. Neither
   * the worker nor the "mark as no-show" action itself is implemented in this phase. */
  noShowStartedAt?: Date | undefined;
  noShowDeadlineAt?: Date | undefined;
  cancellationPolicySnapshot?: BookingCancellationPolicySnapshot | undefined;
  cancellationOutcome?: BookingCancellationOutcome | undefined;
  completionPayment?: BookingCompletionPayment | undefined;
  promo?: BookingPromoSnapshot | undefined;
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
    reservationId: {
      type: Schema.Types.ObjectId,
      ref: "BookingSlotReservation",
      required: true,
    },
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

/**
 * Structural money invariants that can never legitimately be violated regardless of pricing
 * policy, deposit strategy, or payment state — deliberately NOT a deposit formula (no rule
 * constrains depositCents itself beyond "not more than the total"; see
 * BookingService.calculateBookingDepositCents for where the actual [€5, €35] deposit clamp is
 * computed, at write time, for every BOOKLY_MANAGED booking) and deliberately NOT an exact
 * platformFeeCents formula (0 is valid both for a MANUAL Booking and for a RETURNING customer's
 * BOOKLY_MANAGED booking — see the Batch 6.5 correction: platformFeeCents === 0 no longer
 * implies "no deposit was collected", only "this deposit is Business-owned, not Bookly's own
 * activation revenue"; only a *nonzero* platformFeeCents is bounded to the confirmed [€5, €35]
 * range, since a nonzero platform fee is always exactly the first-booking deposit amount).
 * Every one of these must hold for every legitimate future state named in the audit — no
 * deposit (depositCents 0, e.g. MANUAL), full balance collected upfront (depositCents ===
 * totalCents), a later refund/cancellation/no-show (those rewrite this whole snapshot
 * consistently, which is exactly what these checks require of any writer, present or future).
 */
bookingFinancialsSchema.pre("validate", function () {
  const financials = this as unknown as BookingFinancials;

  if (financials.serviceDiscountCents > financials.servicesSubtotalCents) {
    throw new Error("serviceDiscountCents cannot exceed servicesSubtotalCents");
  }

  const expectedBasis =
    financials.servicesSubtotalCents +
    financials.addonsSubtotalCents -
    financials.serviceDiscountCents;
  if (financials.eligiblePlatformFeeBasisCents !== expectedBasis) {
    throw new Error(
      "eligiblePlatformFeeBasisCents must equal servicesSubtotalCents + addonsSubtotalCents - serviceDiscountCents (travel fee excluded by design)",
    );
  }

  if (
    financials.platformFeeCents !== 0 &&
    (financials.platformFeeCents < DEPOSIT_MIN_CENTS ||
      financials.platformFeeCents > DEPOSIT_MAX_CENTS)
  ) {
    throw new Error(
      `A nonzero platformFeeCents must be within [${DEPOSIT_MIN_CENTS}, ${DEPOSIT_MAX_CENTS}]`,
    );
  }

  if (financials.depositCents > financials.totalCents) {
    throw new Error("depositCents cannot exceed totalCents");
  }

  if (financials.balanceDueCents !== financials.totalCents - financials.depositCents) {
    throw new Error("balanceDueCents must equal totalCents - depositCents");
  }
});

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

const bookingCancellationTierRuleSnapshotSchema = new Schema<
  BookingCancellationPolicySnapshot["tiers"][number]
>(
  {
    tier: { type: String, enum: cancellationTiers, required: true },
    mode: { type: String, enum: cancellationFeeModes, required: true },
    percentage: {
      type: Number,
      min: CANCELLATION_PERCENTAGE_MIN,
      max: CANCELLATION_PERCENTAGE_MAX,
    },
  },
  { _id: false },
);

const bookingCancellationPolicySnapshotSchema = new Schema<BookingCancellationPolicySnapshot>(
  {
    tiers: { type: [bookingCancellationTierRuleSnapshotSchema], required: true },
    noShowPercentage: {
      type: Number,
      required: true,
      min: CANCELLATION_PERCENTAGE_MIN,
      max: CANCELLATION_PERCENTAGE_MAX,
    },
  },
  { _id: false },
);

const bookingCancellationOutcomeSchema = new Schema<BookingCancellationOutcome>(
  {
    classifiedAt: { type: Date, required: true },
    tier: { type: String, enum: cancellationTiers, required: true },
    feeMode: { type: String, enum: cancellationFeeModes, required: true },
    feePercentage: {
      type: Number,
      min: CANCELLATION_PERCENTAGE_MIN,
      max: CANCELLATION_PERCENTAGE_MAX,
    },
    cancellationFeeCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    depositAppliedCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    additionalChargeCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    refundOwedCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    settlementStatus: {
      type: String,
      enum: ["NOT_APPLICABLE", "PENDING", "SUCCEEDED", "FAILED", "WAIVED"],
      required: true,
      default: "NOT_APPLICABLE",
    },
    settlementProviderReference: { type: String, trim: true },
  },
  { _id: false },
);

const bookingCompletionPaymentSchema = new Schema<BookingCompletionPayment>(
  {
    paid: { type: Boolean, required: true },
    amountCents: { type: Number, min: 0, validate: Number.isInteger },
    note: { type: String, trim: true, maxlength: 2000 },
    recordedAt: { type: Date, required: true },
    recordedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { _id: false },
);

const bookingPromoSnapshotSchema = new Schema<BookingPromoSnapshot>(
  {
    promoId: { type: Schema.Types.ObjectId, ref: "PromoCode", required: true },
    code: { type: String, required: true },
    type: { type: String, enum: ["PERCENTAGE", "FIXED"], required: true },
    value: { type: Number, required: true, min: 0 },
    discountCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    chargeCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    fundingOwner: { type: String, enum: ["BOOKLY"], required: true },
    appliedAt: { type: Date, required: true },
  },
  { _id: false },
);

const bookingSchema = new Schema<BookingDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    reference: { type: String, required: true, trim: true, uppercase: true },
    source: { type: String, enum: bookingSources, required: true, default: "BOOKLY_MANAGED" },
    status: { type: String, enum: bookingStatuses, required: true, default: "UPCOMING" },
    googleCalendarEventId: { type: String },
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
    noShowStartedAt: { type: Date },
    noShowDeadlineAt: { type: Date },
    cancellationPolicySnapshot: { type: bookingCancellationPolicySnapshotSchema },
    cancellationOutcome: { type: bookingCancellationOutcomeSchema },
    completionPayment: { type: bookingCompletionPaymentSchema },
    promo: { type: bookingPromoSnapshotSchema },
    notes: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true },
);

// Both-or-neither, and the deadline must genuinely be after the start — defense in depth for
// the future "mark as no-show" action, which is the only intended writer of these two fields.
bookingSchema.pre("validate", function () {
  const booking = this as unknown as BookingDocument;
  const hasStarted = booking.noShowStartedAt !== undefined;
  const hasDeadline = booking.noShowDeadlineAt !== undefined;

  if (hasStarted !== hasDeadline) {
    throw new Error("noShowStartedAt and noShowDeadlineAt must be set together");
  }

  if (
    hasStarted &&
    hasDeadline &&
    booking.noShowDeadlineAt !== undefined &&
    booking.noShowStartedAt !== undefined &&
    booking.noShowDeadlineAt <= booking.noShowStartedAt
  ) {
    throw new Error("noShowDeadlineAt must be after noShowStartedAt");
  }
});

// Defense in depth for confirmed rule E, duplicating BookingService.validateManualBookingHasNoBooklyFee
// at the persistence layer — a MANUAL Booking is financially outside Bookly entirely, so no
// direct model write (bypassing the service) can ever persist a nonzero Bookly fee/deposit on
// one. BOOKLY_MANAGED Bookings are unconstrained here; their actual fee/deposit values are
// Phase 2/3 payment work.
bookingSchema.pre("validate", function () {
  const booking = this as unknown as BookingDocument;

  if (
    booking.source === "MANUAL" &&
    (booking.financials.platformFeeCents !== 0 || booking.financials.depositCents !== 0)
  ) {
    throw new Error("A MANUAL Booking must have platformFeeCents === 0 and depositCents === 0");
  }
});

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
// The future no-show background worker's exact query shape: efficiently find every Booking
// still `status: "PENDING"` whose noShowDeadlineAt has passed. Partial (not sparse) — scoped
// to documents that actually have a noShowDeadlineAt at all, which is the large majority-never
// case (no-show is a deliberate action on a specific Booking, not every Booking's default
// path), so this index stays small relative to the whole collection.
bookingSchema.index(
  { status: 1, noShowDeadlineAt: 1 },
  { partialFilterExpression: { noShowDeadlineAt: { $exists: true } } },
);
// Batch 12 — Super Admin Booking Analytics: platform-wide (unscoped to one Business) time-series
// and period-bounded status-distribution queries filter/sort by createdAt across the whole
// collection; no existing index leads with createdAt.
bookingSchema.index({ createdAt: -1 });

export const BookingModel = model<BookingDocument>("Booking", bookingSchema);
