import type { ClientSession, Types } from "mongoose";
import type { BusinessDocument } from "../business/business.model.js";
import { PromoError } from "./promo.errors.js";
import type { PromoCodeDocument } from "./promo.model.js";
import type { PromoRepository } from "./promo.repository.js";
import type { PromoRedemptionRepository } from "./promo-redemption.repository.js";
import type { PromoUserUsageRepository } from "./promo-user-usage.repository.js";

/** P2 — a validated promo and its discount off the NORMAL booking price. */
export type ResolvedPromo = {
  promo: PromoCodeDocument;
  /** services + add-ons − service discount (travel excluded) — the price BEFORE the promo. */
  promoEligibleBaseCents: number;
  /** 0 <= promoDiscountCents <= promoEligibleBaseCents. */
  promoDiscountCents: number;
  /** promoEligibleBaseCents − promoDiscountCents: the basis every upfront is computed from. */
  discountedBaseCents: number;
};

/**
 * The ONE place a Promo Code is validated and its discount computed. Both
 * `previewCustomerBooking` and `finalizeCustomerBooking` call `resolve` (finalize re-validates
 * from scratch — never trusts the preview); only `finalizeCustomerBooking`, inside the SAME
 * MongoDB transaction that persists the Booking, calls `claimRedemption` (no pre-payment
 * reservation exists). P2: the promo discounts the NORMAL booking price (services + add-ons −
 * service discount, travel excluded) BEFORE any upfront is computed — the caller computes the
 * FIRST upfront / RETURNING deposit from `discountedBaseCents`. Never applied to a package.
 */
export class PromoApplicationService {
  public constructor(
    private readonly promoRepository: PromoRepository,
    private readonly userUsageRepository: PromoUserUsageRepository,
    private readonly redemptionRepository: PromoRedemptionRepository,
  ) {}

  /**
   * Validates a promo code against scope/dates/status and computes the discount against the
   * already-canonical `depositBeforePromoCents`. `isFirstBooking` is the caller's best current
   * knowledge (an optimistic pre-charge snapshot in `finalizeCustomerBooking`, or the real
   * `activatedAt`-derived value in `previewCustomerBooking`) — `claimRedemption` re-checks this
   * against the REAL, race-resolved outcome before committing. A best-effort (non-atomic) usage
   * check runs here too, purely to fail fast and avoid charging a customer for an obviously
   * exhausted promo — the authoritative, concurrency-safe check is `claimRedemption` alone.
   */
  public async resolve(input: {
    code: string;
    business: BusinessDocument;
    customerUserId: string;
    isFirstBooking: boolean;
    promoEligibleBaseCents: number;
    now?: Date;
  }): Promise<ResolvedPromo> {
    const now = input.now ?? new Date();
    const normalizedCode = input.code.trim().toUpperCase();
    if (!normalizedCode) {
      throw new PromoError("PROMO_INVALID", 400);
    }

    const promo = await this.promoRepository.findByNormalizedCode(normalizedCode);
    if (!promo) {
      throw new PromoError("PROMO_INVALID", 400);
    }

    this.assertValidNow(promo, now);
    this.assertScopeEligible(promo, input.business._id, input.isFirstBooking);

    if (promo.totalUsageLimit !== undefined && promo.redeemedCount >= promo.totalUsageLimit) {
      throw new PromoError("PROMO_USAGE_LIMIT_REACHED", 409);
    }
    if (promo.perUserUsageLimit !== undefined) {
      const used = await this.userUsageRepository.countForCustomer(promo._id, input.customerUserId);
      if (used >= promo.perUserUsageLimit) {
        throw new PromoError("PROMO_PER_USER_LIMIT_REACHED", 409);
      }
    }

    const promoDiscountCents = this.computeDiscountCents(promo, input.promoEligibleBaseCents);

    return {
      promo,
      promoEligibleBaseCents: input.promoEligibleBaseCents,
      promoDiscountCents,
      discountedBaseCents: input.promoEligibleBaseCents - promoDiscountCents,
    };
  }

  /**
   * The authoritative, concurrency-safe consumption — called ONLY inside the same transaction
   * that persists the redeeming Booking, AFTER the real first/returning outcome is known (see
   * booking-creation.service.ts's own comment on why this must be the real, not optimistic,
   * value for an ALL_FIRST_BOOKINGS promo). Re-validates scope against the REAL `isFirstBooking`
   * one more time — a promo previewed/charged as first-booking-eligible must never be silently
   * honored if the activation race resolved the OTHER way; the caller maps a thrown error here to
   * the existing post-payment compensation/refund path, never to a silent price change.
   */
  public async claimRedemption(
    input: {
      resolved: ResolvedPromo;
      /** The upfront computed from the discounted basis — what the customer pays online. */
      requiredUpfrontCents: number;
      bookingId: Types.ObjectId;
      businessId: Types.ObjectId;
      customerUserId: Types.ObjectId;
      isFirstBooking: boolean;
    },
    session: ClientSession,
  ): Promise<void> {
    const { promo } = input.resolved;

    this.assertScopeEligible(promo, input.businessId, input.isFirstBooking);

    const globalClaim = await this.promoRepository.claimGlobalUsage(
      promo._id,
      promo.totalUsageLimit,
      session,
    );
    if (!globalClaim) {
      throw new PromoError("PROMO_USAGE_LIMIT_REACHED", 409);
    }

    const perUserClaimed = await this.userUsageRepository.claim(
      promo._id,
      input.customerUserId,
      promo.perUserUsageLimit,
      session,
    );
    if (!perUserClaimed) {
      throw new PromoError("PROMO_PER_USER_LIMIT_REACHED", 409);
    }

    await this.redemptionRepository.create(
      {
        promoId: promo._id,
        codeSnapshot: promo.code,
        typeSnapshot: promo.type,
        valueSnapshot: promo.value,
        bookingId: input.bookingId,
        businessId: input.businessId,
        customerUserId: input.customerUserId,
        // P2: no pre-promo deposit exists — the upfront is computed after the price discount,
        // so both upfront snapshots are that one amount (see PromoRedemptionDocument).
        promoEligibleBaseCents: input.resolved.promoEligibleBaseCents,
        depositBeforePromoCents: input.requiredUpfrontCents,
        promoDiscountCents: input.resolved.promoDiscountCents,
        customerChargeNowCents: input.requiredUpfrontCents,
        fundingOwner: "BUSINESS",
        isFirstBooking: input.isFirstBooking,
        userUsageCounted: promo.perUserUsageLimit !== undefined,
      },
      session,
    );
  }

  private assertValidNow(promo: PromoCodeDocument, now: Date): void {
    if (promo.status === "DEACTIVATED") {
      throw new PromoError("PROMO_DEACTIVATED", 400);
    }
    if (promo.startAt && now < promo.startAt) {
      throw new PromoError("PROMO_NOT_STARTED", 400);
    }
    if (now >= promo.expiresAt) {
      throw new PromoError("PROMO_EXPIRED", 400);
    }
  }

  private assertScopeEligible(
    promo: PromoCodeDocument,
    businessId: Types.ObjectId,
    isFirstBooking: boolean,
  ): void {
    if (promo.scope === "SELECTED_BUSINESSES") {
      const eligible = promo.businessIds.some((id) => String(id) === String(businessId));
      if (!eligible) {
        throw new PromoError("PROMO_NOT_ELIGIBLE_FOR_BUSINESS", 400);
      }
      return;
    }
    if (promo.scope === "ALL_FIRST_BOOKINGS" && !isFirstBooking) {
      throw new PromoError("PROMO_FIRST_BOOKING_ONLY", 400);
    }
  }

  /** Against the promo-eligible booking price (`base`). FIXED: `min(valueCents, base)` — never
   * negative, never a customer credit, an unused remainder simply disappears. PERCENTAGE:
   * `round(base × percentage / 100)` (unchanged rounding), clamped to [0, base] — there is NO
   * separate promo cap; a 100% promo legitimately zeroes the discounted price. */
  private computeDiscountCents(promo: PromoCodeDocument, base: number): number {
    const computed =
      promo.type === "FIXED" ? Math.round(promo.value) : Math.round((base * promo.value) / 100);
    return Math.min(Math.max(0, computed), base);
  }
}
