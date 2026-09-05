import { model, Schema, type Types } from "mongoose";

/**
 * The Package Deal entitlement — "purchased sessions -> used sessions -> remaining sessions"
 * for exactly ONE Package Deal Service a Customer bought at a Business (confirmed rule: a
 * Package is multiple sessions of the SAME Service — see service.model.ts's packagePricing,
 * which has exactly one durationMin/bundlePriceCents for the whole package, structurally
 * ruling out a bundle-of-distinct-services reading). This is the small entitlement collection
 * booking.model.ts's own `packageProgressId`/`sessionIndex` fields were already reserved for
 * (see BookingServiceLinePricingInput's doc comment — "confirmed rule K") but never built until
 * now.
 *
 * LIFECYCLE: created once, at purchase, by BookingCreationService.finalizePackagePurchase — the
 * SAME transaction that creates the purchase Booking (session 1, fully paid: deposit online +
 * balance off-platform, exactly like any FIXED-price booking — see that method's own comment).
 * `remainingSessions` then only ever moves via the atomic operations on
 * PackageProgressRepository: -1 when a session is redeemed (claimSession), +1 ONLY when an
 * already-scheduled session is cancelled ON TIME or a no-show is reversed by the Business
 * (resolveSessionOutcome with outcome "RESTORE" — see package-progress.rules.ts). A LATE
 * cancellation or a genuine no-show forfeits the session instead (outcome "FORFEIT") — the slot
 * is never returned. `completedSessions` is purely informational — it increments when a
 * redeemed session's own Booking actually completes, but never feeds back into
 * `remainingSessions` math.
 *
 * `status` is deliberately NOT stored — "ACTIVE" / "DEPLETED" / "VOIDED" is a pure function of
 * `remainingSessions > 0` and `voidedAt`, computed at read time (package-progress.dto.ts), never
 * a separately-written field that could drift out of sync with the counters it describes.
 *
 * NO EXPIRY FIELD (confirmed default: packages do not expire in this phase — no product rule
 * or existing field anywhere in the repository establishes one). Additive to add later.
 *
 * SESSION STATUS — "CANCELLED" vs "FORFEITED" (Phase 4B corrections):
 *  - "CANCELLED" — an ON-TIME cancellation (by either party) or a business-reversed no-show
 *    (`NO_SHOW_CANCELLED`) — the session slot IS returned to `remainingSessions`.
 *  - "FORFEITED" — a LATE cancellation or a genuine no-show (`NO_SHOW_CHARGED`/`NO_SHOW_WAIVED`)
 *    — the session is consumed for good, exactly like a COMPLETED one, and is never restored.
 *    The Package's own confirmed rule: "the lost session IS the penalty" — no additional
 *    Package base-service fee is ever charged on top (see package-progress.rules.ts, which is
 *    the single place a Booking's terminal status is mapped to RESTORE/FORFEIT/NONE, reused
 *    identically by every call site instead of re-deriving this decision per call site).
 */
export type PackageProgressSessionStatus = "SCHEDULED" | "COMPLETED" | "CANCELLED" | "FORFEITED";

export type PackageProgressSession = {
  /** 1-based, assigned atomically at claim time from the post-decrement remainingSessions —
   * see PackageProgressRepository.claimSession's own comment for why this is race-safe without
   * a separate counter field. */
  sessionIndex: number;
  bookingId: Types.ObjectId;
  status: PackageProgressSessionStatus;
};

/** Snapshotted at purchase time — a later edit to the Service's packagePricing must never
 * retroactively change what this Customer already bought (same immutable-snapshot discipline
 * BookingServiceLine.serviceSnapshot already established for every normal Booking). */
export type PackageProgressPurchaseSnapshot = {
  name: string;
  packageServicesName?: string | undefined;
  bundlePriceCents: number;
  durationMin: number;
  sessionsInPackage: number;
  discountPercent?: number | undefined;
};

export type PackageProgressDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  customerUserId: Types.ObjectId;
  businessClientId: Types.ObjectId;
  /** The ONE Package Deal Service this entitlement is for (Type 1 — see this file's own doc
   * comment). Not re-validated as still ACTIVE here; redemption re-resolves the live Service via
   * BookingService.validateResponsibleStaff exactly like any other booking, so an
   * archived/deactivated Service naturally blocks further redemption without any extra field. */
  serviceId: Types.ObjectId;
  totalSessions: number;
  remainingSessions: number;
  completedSessions: number;
  sessions: PackageProgressSession[];
  /** The purchase Booking — session 1, the one Booking that actually carried a real charge. */
  originBookingId: Types.ObjectId;
  purchaseSnapshot: PackageProgressPurchaseSnapshot;
  /** Set once, only by BookingLifecycleService.voidUnusedPackage, when a genuinely completely
   * unused Package is refunded/void — see that method's own doc comment for the exact
   * eligibility rule. Once set, the entitlement can never be redeemed against again
   * (redeemPackageSession's own guard checks this). Never set for a partially-used Package —
   * this is a hard block, not a soft status a later action can clear. */
  voidedAt?: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const purchaseSnapshotSchema = new Schema<PackageProgressPurchaseSnapshot>(
  {
    name: { type: String, required: true, trim: true },
    packageServicesName: { type: String, trim: true },
    bundlePriceCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    durationMin: { type: Number, required: true, min: 1 },
    sessionsInPackage: { type: Number, required: true, min: 1, validate: Number.isInteger },
    discountPercent: { type: Number, min: 0, max: 100 },
  },
  { _id: false },
);

const sessionSchema = new Schema<PackageProgressSession>(
  {
    sessionIndex: { type: Number, required: true, min: 1, validate: Number.isInteger },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    status: {
      type: String,
      enum: ["SCHEDULED", "COMPLETED", "CANCELLED", "FORFEITED"],
      required: true,
    },
  },
  { _id: false },
);

const packageProgressSchema = new Schema<PackageProgressDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    customerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    businessClientId: { type: Schema.Types.ObjectId, ref: "BusinessClient", required: true },
    serviceId: { type: Schema.Types.ObjectId, ref: "Service", required: true },
    totalSessions: { type: Number, required: true, min: 1, validate: Number.isInteger },
    remainingSessions: { type: Number, required: true, min: 0, validate: Number.isInteger },
    completedSessions: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
      validate: Number.isInteger,
    },
    sessions: { type: [sessionSchema], required: true, default: [] },
    originBookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    purchaseSnapshot: { type: purchaseSnapshotSchema, required: true },
    voidedAt: { type: Date },
  },
  { timestamps: true },
);

// One entitlement per purchase Booking — defense in depth against ever double-inserting from
// the same purchase transaction (the transaction itself already prevents this in practice;
// this index makes it structurally impossible too).
packageProgressSchema.index({ originBookingId: 1 }, { unique: true });
// "My Packages" cross-business list (newest first) — mirrors Booking's own customer-scoped
// list index shape.
packageProgressSchema.index({ customerUserId: 1, createdAt: -1 });
// Business-scoped lookup — "does this customer have an active package for this service" and
// the redemption endpoint's own ownership-scoped find.
packageProgressSchema.index({ businessId: 1, customerUserId: 1, serviceId: 1 });
// The cancellation/completion hooks' own lookup — "which PackageProgress (if any) does this
// Booking belong to". Non-unique: a given bookingId only ever appears in one document by
// construction, but nothing here relies on the index itself enforcing that.
packageProgressSchema.index({ "sessions.bookingId": 1 });

export const PackageProgressModel = model<PackageProgressDocument>(
  "PackageProgress",
  packageProgressSchema,
);
