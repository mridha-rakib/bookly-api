import type { ClientSession, Types } from "mongoose";
import type { BusinessDocument } from "../business/business.model.js";
import { PromoError } from "./promo.errors.js";
import type { PromoCodeDocument } from "./promo.model.js";
import type { PromoRepository } from "./promo.repository.js";
import type { PromoRedemptionRepository } from "./promo-redemption.repository.js";
import type { PromoUserUsageRepository } from "./promo-user-usage.repository.js";

export type ResolvedPromo = {
  promo: PromoCodeDocument;
  depositBeforePromoCents: number;
  promoDiscountCents: number;
  customerChargeNowCents: number;
};

/**
 * Batch 13 — the ONE place a Promo Code is validated and its discount computed. Both
 * `previewCustomerBooking` and `finalizeCustomerBooking` call `resolve` (finalize re-validates
 * from scratch — never trusts the preview); only `finalizeCustomerBooking`, inside the SAME
 * MongoDB transaction that persists the Booking, calls `claimRedemption`. Never a second pricing
 * engine: this only ever discounts the ALREADY-COMPUTED `depositBeforePromoCents` (the existing
 * clamp(20%, €5, €35) canonical deposit) — it never touches Service pricing, add-ons, travel fee,
 * or `eligiblePlatformFeeBasisCents`.
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
    depositBeforePromoCents: number;
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

    const promoDiscountCents = this.computeDiscountCents(promo, input.depositBeforePromoCents);
    const customerChargeNowCents = Math.max(0, input.depositBeforePromoCents - promoDiscountCents);

    return {
      promo,
      depositBeforePromoCents: input.depositBeforePromoCents,
      promoDiscountCents,
      customerChargeNowCents,
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
        depositBeforePromoCents: input.resolved.depositBeforePromoCents,
        promoDiscountCents: input.resolved.promoDiscountCents,
        customerChargeNowCents: input.resolved.customerChargeNowCents,
        fundingOwner: "BOOKLY",
        isFirstBooking: input.isFirstBooking,
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

  /** FIXED: `min(fixedValueCents, depositBeforePromoCents)` — never negative, never a customer
   * credit, an unused remainder simply disappears (rule #5). PERCENTAGE: `round(deposit ×
   * percentage / 100)`, clamped at `depositBeforePromoCents` — there is NO separate promo cap
   * (the deposit itself is already capped at €35); a 100% promo may legitimately zero the charge. */
  private computeDiscountCents(promo: PromoCodeDocument, depositBeforePromoCents: number): number {
    if (promo.type === "FIXED") {
      return Math.min(Math.round(promo.value), depositBeforePromoCents);
    }
    const computed = Math.round((depositBeforePromoCents * promo.value) / 100);
    return Math.min(computed, depositBeforePromoCents);
  }
}
