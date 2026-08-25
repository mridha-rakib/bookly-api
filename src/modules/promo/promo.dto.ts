import type { PromoCodeDocument } from "./promo.model.js";
import type { PromoScope, PromoType } from "./promo.types.js";
import type { PromoRedemptionDocument } from "./promo-redemption.model.js";

/** Batch 13 — EXPIRED is derived here (never stored — see promo.types.ts's own doc comment):
 * a DEACTIVATED promo stays DEACTIVATED regardless of date; an ACTIVE promo whose `expiresAt`
 * has passed reads as EXPIRED to every caller without needing a background job to flip it. */
export type PromoDisplayStatus = "ACTIVE" | "EXPIRED" | "DEACTIVATED";

export const derivePromoDisplayStatus = (
  promo: Pick<PromoCodeDocument, "status" | "expiresAt">,
  now: Date = new Date(),
): PromoDisplayStatus => {
  if (promo.status === "DEACTIVATED") return "DEACTIVATED";
  if (now >= promo.expiresAt) return "EXPIRED";
  return "ACTIVE";
};

export type PromoListItemDto = {
  id: string;
  code: string;
  type: PromoType;
  value: number;
  scope: PromoScope;
  businessIds: string[];
  startAt?: string | undefined;
  expiresAt: string;
  status: PromoDisplayStatus;
  totalUsageLimit?: number | undefined;
  perUserUsageLimit?: number | undefined;
  redeemedCount: number;
  createdAt: string;
};

export type PromoDetailDto = PromoListItemDto & {
  businesses: Array<{ id: string; name: string }>;
};

export const toPromoListItemDto = (promo: PromoCodeDocument): PromoListItemDto => ({
  id: String(promo._id),
  code: promo.code,
  type: promo.type,
  value: promo.value,
  scope: promo.scope,
  businessIds: promo.businessIds.map((id) => String(id)),
  startAt: promo.startAt?.toISOString(),
  expiresAt: promo.expiresAt.toISOString(),
  status: derivePromoDisplayStatus(promo),
  totalUsageLimit: promo.totalUsageLimit,
  perUserUsageLimit: promo.perUserUsageLimit,
  redeemedCount: promo.redeemedCount,
  createdAt: promo.createdAt.toISOString(),
});

export type PromoRedemptionRowDto = {
  id: string;
  promoId: string;
  code: string;
  customerEmail: string;
  businessId: string;
  businessName: string;
  depositBeforePromoCents: number;
  promoDiscountCents: number;
  customerChargeNowCents: number;
  isFirstBooking: boolean;
  redeemedAt: string;
};

export const toPromoRedemptionRowDto = (
  redemption: PromoRedemptionDocument,
  customerEmail: string,
  businessName: string,
): PromoRedemptionRowDto => ({
  id: String(redemption._id),
  promoId: String(redemption.promoId),
  code: redemption.codeSnapshot,
  customerEmail,
  businessId: String(redemption.businessId),
  businessName,
  depositBeforePromoCents: redemption.depositBeforePromoCents,
  promoDiscountCents: redemption.promoDiscountCents,
  customerChargeNowCents: redemption.customerChargeNowCents,
  isFirstBooking: redemption.isFirstBooking,
  redeemedAt: redemption.redeemedAt.toISOString(),
});
