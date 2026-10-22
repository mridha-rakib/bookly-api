import { DateTime, IANAZone } from "luxon";
import { Types } from "mongoose";
import type { PackageCheckoutValidity } from "./package-checkout-contract.js";

const DAY = 86400000;
const OFFSET_ENVELOPE_MINUTES = 24 * 60;
const requireZone = (zone: string) => {
  if (/^[+-]|^[Zz]$/.test(zone) || zone.trim() !== zone || !IANAZone.isValidZone(zone))
    throw new Error("Invalid named IANA zone");
};
const requireOffset = (offset: number) => {
  if (!Number.isFinite(offset) || Math.abs(offset) > OFFSET_ENVELOPE_MINUTES)
    throw new Error("Unsupported timezone offset envelope");
};
const wallMillis = (time: DateTime) =>
  DateTime.utc(
    time.year,
    time.month,
    time.day,
    time.hour,
    time.minute,
    time.second,
    time.millisecond,
  ).toMillis();

/** Approved purchase-expiry v1. Explicit input only; never an activation constructor.
 * Clamp Gregorian day; preserve wall clock; select later fold; shift gaps forward.
 * Ordinary availability's separate first-fold policy is deliberately not imported.
 */
export const calculatePackageExpiryV1 = (
  purchasedAt: Date,
  months: 6 | 12,
  timezone: string,
): Date => {
  requireZone(timezone);
  if (!Number.isFinite(purchasedAt.getTime()) || ![6, 12].includes(months))
    throw new Error("Invalid purchase date/months");
  const local = DateTime.fromJSDate(purchasedAt, { zone: timezone });
  requireOffset(local.offset);
  const monthIndex = local.year * 12 + local.month - 1 + months;
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const monthStart = DateTime.utc(year, month, 1);
  if (!monthStart.isValid || !monthStart.daysInMonth)
    throw new Error("Unsupported target calendar date");
  const wall = {
    year,
    month,
    day: Math.min(local.day, monthStart.daysInMonth),
    hour: local.hour,
    minute: local.minute,
    second: local.second,
    millisecond: local.millisecond,
  };
  const naive = DateTime.fromObject(wall, { zone: "UTC" }).toMillis();
  if (!Number.isFinite(naive)) throw new Error("Invalid target wall clock");
  // Keep exact requested wall times and explicitly choose the later fold candidate,
  // independent of the initial offset guess used by the library.
  const guess = DateTime.fromObject(wall, { zone: timezone });
  const candidates = guess
    .getPossibleOffsets()
    .filter((time) => time.isValid && wallMillis(time) === naive);
  for (const candidate of candidates) requireOffset(candidate.offset);
  if (candidates.length) return new Date(Math.max(...candidates.map((time) => time.toMillis())));
  // Discard the library's default gap result. Derive and verify a positive gap shift.
  const zone = IANAZone.create(timezone);
  const offsets = new Set([
    zone.offset(naive - 2 * DAY),
    zone.offset(naive + 2 * DAY),
    guess.offset,
  ]);
  const forward: Array<{ shift: number; instant: number }> = [];
  for (const offset of offsets) {
    requireOffset(offset);
    const instant = naive - offset * 60000;
    const resolved = DateTime.fromMillis(instant, { zone: timezone });
    requireOffset(resolved.offset);
    const shift = wallMillis(resolved) - naive;
    if (resolved.isValid && shift > 0 && shift === (resolved.offset - offset) * 60000)
      forward.push({ shift, instant });
  }
  forward.sort((left, right) => left.shift - right.shift || right.instant - left.instant);
  const result = forward[0];
  if (!result) throw new Error("Cannot prove a gap-forward expiry resolution");
  return new Date(result.instant);
};

const calendarMinimumCache = new Map<6 | 12, number>();
/** Complete Gregorian 400-year cycle, including EVERY source date and target clamp.
 * A finite calendar proof, not quote-window sampling: it derives minimum wall-calendar
 * distances (181/365 days) instead of inventing commercial validity durations. */
export const minimumGregorianValidityDays = (months: 6 | 12): number => {
  if (![6, 12].includes(months)) throw new Error("Unsupported validity months");
  const cached = calendarMinimumCache.get(months);
  if (cached !== undefined) return cached;
  let minimum = Infinity;
  for (let year = 2000; year < 2400; year++)
    for (let month = 0; month < 12; month++) {
      const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const targetDays = new Date(Date.UTC(year, month + months + 1, 0)).getUTCDate();
      for (let day = 1; day <= days; day++) {
        const distance =
          (Date.UTC(year, month + months, Math.min(day, targetDays)) - Date.UTC(year, month, day)) /
          DAY;
        minimum = Math.min(minimum, distance);
      }
    }
  calendarMinimumCache.set(months, minimum);
  return minimum;
};

/** Proven conservative LOWER BOUND, not the tight zone/window-specific minimum.
 * The Gregorian-cycle proof supplies minimum calendar distance. Supported source and
 * target offsets each have absolute value <=24h, losing at most two more days.
 * Gap-forward adds wall time. Thus E(t)>=t+(calendarMinimum-2) days for EVERY supported
 * t, hence >=windowStart+that duration over the entire accepted interval.
 * No endpoint-only assumption, window transition sampling or monotonic-clamp claim.
 */
export const prepareFinitePackageValidityV1 = (input: {
  months: 6 | 12;
  timezone: string;
  activationNotBefore: Date;
  activationNotAfterExclusive: Date;
  guaranteeProofRef: Types.ObjectId;
}): Extract<PackageCheckoutValidity, { mode: "FINITE" }> => {
  const { months, timezone, activationNotBefore, activationNotAfterExclusive, guaranteeProofRef } =
    input;
  if (
    !Number.isFinite(activationNotBefore.getTime()) ||
    !Number.isFinite(activationNotAfterExclusive.getTime()) ||
    activationNotBefore >= activationNotAfterExclusive
  )
    throw new Error("Invalid activation interval");
  const estimatedExpiresAt = calculatePackageExpiryV1(activationNotBefore, months, timezone);
  const guaranteedNotBeforeExpiry = new Date(
    activationNotBefore.getTime() + (minimumGregorianValidityDays(months) - 2) * DAY,
  );
  if (
    !Number.isFinite(guaranteedNotBeforeExpiry.getTime()) ||
    guaranteedNotBeforeExpiry <= activationNotAfterExclusive ||
    estimatedExpiresAt < guaranteedNotBeforeExpiry ||
    !(guaranteeProofRef instanceof Types.ObjectId)
  )
    throw new Error("Invalid guarantee/window/provenance");
  return Object.freeze({
    mode: "FINITE",
    months,
    timezone,
    activationNotBefore,
    activationNotAfterExclusive,
    calculationVersion: 1,
    estimatedExpiresAt,
    guaranteedNotBeforeExpiry,
    guaranteeMethod: "CONSERVATIVE_GREGORIAN_OFFSET_ENVELOPE_V1",
    guaranteeProofRef,
  });
};

/** Future P3-B calls only with the real winning activation time. This assertion cannot
 * establish that a payment, winning activation event or atomic transaction exists. */
export const validatePackageActivationDeadline = (
  validity: PackageCheckoutValidity,
  purchasedAt: Date,
  starts: readonly Date[],
): Date | undefined => {
  if (
    !Number.isFinite(purchasedAt.getTime()) ||
    !starts.length ||
    starts.some((start) => !Number.isFinite(start.getTime()) || start <= purchasedAt)
  )
    throw new Error("Invalid activation/schedule input");
  if (validity.mode === "FOREVER") return undefined;
  if (
    purchasedAt < validity.activationNotBefore ||
    purchasedAt >= validity.activationNotAfterExclusive
  )
    throw new Error("Activation outside accepted window");
  const expiry = calculatePackageExpiryV1(purchasedAt, validity.months, validity.timezone);
  if (
    expiry < validity.guaranteedNotBeforeExpiry ||
    purchasedAt >= expiry ||
    starts.some((start) => start >= expiry)
  )
    throw new Error("Finite authorization/start deadline violated");
  return expiry;
};
