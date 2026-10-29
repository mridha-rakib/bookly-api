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
  /** Booked quantity from `pricingInput` (hours, people, package session) — absent for FIXED. */
  quantityLabel?: string;
};

/**
 * F4A Tier 3 — what Bookly can VERIFY about the online payment for this Booking. Supplied only
 * by the booking-created notifier from the Booking transaction's own ledger row + the
 * SUCCEEDED PaymentAttempt. Absent = not evaluated (legacy callers keep the legacy row).
 *  - PAID: a captured payment with ledger + provider evidence that agree.
 *  - NONE: no online payment was attempted for this Booking (no PaymentIntent exists).
 *  - UNVERIFIED: a payment exists but the evidence is incomplete — never shown as paid.
 */
export type BookingEmailOnlinePayment =
  | {
      kind: "PAID";
      amountFormatted: string;
      /** Provider success time in the business timezone, with the timezone name. */
      paidAt: string;
      /** The provider payment reference (Stripe PaymentIntent id). Never a secret. */
      paymentReference: string;
      paymentFor: "BOOKING" | "PACKAGE_PURCHASE" | "PACKAGE_SESSION_EXTRAS";
    }
  | { kind: "NONE" }
  | { kind: "UNVERIFIED" };

/** F4A Tier 3 — the Booking's AGREED cancellation/no-show terms, from its own snapshot. */
export type BookingEmailPolicyDisclosure = {
  /** Package-linked: a late cancellation or no-show forfeits the session, no percentage fee. */
  packageLinked: boolean;
  /** The fee basis (`financials.eligiblePlatformFeeBasisCents`: services + add-ons − discount,
   * excluding travel). */
  basisFormatted: string;
  windows: Array<{ label: string; fee: string }>;
  noShow: string;
  /** True when a percentage fee can apply and an online payment would count towards it. */
  upfrontCountsTowardsFee: boolean;
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
  /** IANA timezone of `appointmentDate`/`appointmentTime` (the Booking's own schedule). */
  timezone?: string;
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
  /** Present only when the Booking carries a cancellation policy snapshot (Tier 3). */
  policyDisclosure?: BookingEmailPolicyDisclosure;
  /** Present only when the caller verified the online payment state (Tier 3). */
  onlinePayment?: BookingEmailOnlinePayment;
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

/** `Monday 3 November 2026 at 10:00 (Europe/Nicosia)` — display only. */
export const formatDateTimeWithZone = (date: Date, timezone: string): string =>
  `${formatDateInTimezone(date, timezone)} at ${formatTimeInTimezone(date, timezone)} (${timezone})`;

const quantityLabelOf = (input: BookingDocument["serviceLines"][number]["pricingInput"]) => {
  const parts: string[] = [];
  if (input.sessionsInPackage && input.sessionIndex)
    parts.push(`Package session ${input.sessionIndex} of ${input.sessionsInPackage}`);
  if (input.hours) parts.push(`${input.hours} ${input.hours === 1 ? "hour" : "hours"}`);
  if (input.personCount)
    parts.push(`${input.personCount} ${input.personCount === 1 ? "person" : "people"}`);
  return parts.length > 0 ? parts.join(", ") : undefined;
};

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * The five FIXED cancellation windows, hours before `schedule.startAt` — identical to
 * classifyCancellationTier (booking-cancellation-classification.ts): >=72, [24,72), [12,24),
 * [2,12), <2. Only the fee per window is business-configurable (snapshotted on the Booking).
 */
const POLICY_WINDOWS = [
  { tier: "MORE_THAN_72_HOURS", from: undefined, to: 72 },
  { tier: "BETWEEN_24_AND_72_HOURS", from: 72, to: 24 },
  { tier: "BETWEEN_12_AND_24_HOURS", from: 24, to: 12 },
  { tier: "BETWEEN_2_AND_12_HOURS", from: 12, to: 2 },
  { tier: "UNDER_2_HOURS", from: 2, to: undefined },
] as const;

/**
 * Mirrors buildCancellationOutcome / computeNoShowPenalty exactly: a missing tier rule is FREE;
 * PERCENTAGE applies to `eligiblePlatformFeeBasisCents` and nets against the succeeded upfront
 * payment; a package-linked Booking forfeits the session instead of paying a percentage. Windows
 * that had already ended when the Booking was created are omitted.
 */
const buildPolicyDisclosure = (
  booking: BookingDocument,
): BookingEmailPolicyDisclosure | undefined => {
  const snapshot = booking.cancellationPolicySnapshot;
  if (!snapshot) return undefined;
  const tz = booking.schedule.timezone;
  const start = booking.schedule.startAt.getTime();
  const createdAt = (booking.createdAt ?? new Date()).getTime();
  const packageLinked = booking.serviceLines.some((line) => line.pricingInput.packageProgressId);
  const basisFormatted = formatMoney(
    booking.financials.eligiblePlatformFeeBasisCents,
    booking.financials.currency,
  );
  const at = (hours: number) => formatDateTimeWithZone(new Date(start - hours * MS_PER_HOUR), tz);
  const feeFor = (tier: string): { text: string; percentage: boolean } => {
    const rule = snapshot.tiers.find((entry) => entry.tier === tier);
    if (rule?.mode !== "PERCENTAGE" || rule.percentage === undefined)
      return { text: "No fee", percentage: false };
    return packageLinked
      ? { text: "The package session is forfeited (no extra fee)", percentage: false }
      : { text: `${rule.percentage}% of ${basisFormatted}`, percentage: true };
  };

  let anyPercentage = false;
  const windows: BookingEmailPolicyDisclosure["windows"] = [];
  for (const window of POLICY_WINDOWS) {
    if (window.to !== undefined && start - window.to * MS_PER_HOUR <= createdAt) continue;
    const fee = feeFor(window.tier);
    anyPercentage ||= fee.percentage;
    const label =
      window.from === undefined
        ? `Cancel by ${at(window.to)}`
        : window.to === undefined
          ? `Cancel after ${at(window.from)}`
          : `Cancel between ${at(window.from)} and ${at(window.to)}`;
    windows.push({ label, fee: fee.text });
  }

  const noShowPercentage = packageLinked ? undefined : snapshot.noShowPercentage;
  const noShow = packageLinked
    ? "A no-show forfeits the package session (no extra fee)"
    : noShowPercentage
      ? `${noShowPercentage}% of ${basisFormatted}`
      : "No fee";
  return {
    packageLinked,
    basisFormatted,
    windows,
    noShow,
    upfrontCountsTowardsFee: !packageLinked && (anyPercentage || Boolean(noShowPercentage)),
  };
};

export const buildBookingEmailData = (
  booking: BookingDocument,
  context: {
    businessName: string;
    includeCustomerBookingLink: boolean;
    /** F4A Tier 3 — verified online payment state; omit when not evaluated. */
    onlinePayment?: BookingEmailOnlinePayment | undefined;
  },
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
    ...(quantityLabelOf(line.pricingInput)
      ? { quantityLabel: quantityLabelOf(line.pricingInput) as string }
      : {}),
  }));
  const policyDisclosure = buildPolicyDisclosure(booking);

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
    timezone: tz,
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
    ...(policyDisclosure ? { policyDisclosure } : {}),
    ...(context.onlinePayment ? { onlinePayment: context.onlinePayment } : {}),
    ...(context.includeCustomerBookingLink && booking.customer.customerUserId
      ? { customerBookingUrlPath: `/customer/bookings/view?id=${String(booking._id)}` }
      : {}),
  };
};
