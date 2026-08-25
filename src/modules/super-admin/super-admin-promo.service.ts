import type { BusinessRepository } from "../business/business.repository.js";
import {
  type PromoDetailDto,
  type PromoListItemDto,
  type PromoRedemptionRowDto,
  toPromoListItemDto,
  toPromoRedemptionRowDto,
} from "../promo/promo.dto.js";
import type {
  PromoCreateRequest,
  PromoService,
  PromoUpdateRequest,
} from "../promo/promo.service.js";
import type { PromoRedemptionRepository } from "../promo/promo-redemption.repository.js";
import type { UserRepository } from "../user/user.repository.js";

export type SuperAdminPromoListResult = {
  promos: PromoListItemDto[];
  pagination: { page: number; limit: number; total: number };
};

export type SuperAdminPromoRedemptionListResult = {
  redemptions: PromoRedemptionRowDto[];
  pagination: { page: number; limit: number; total: number };
};

/** Batch 13 — Super Admin Promo Code CRUD + usage-log surface. Composes the domain
 * `PromoService`/`PromoRedemptionRepository` (never re-implements validation/CAS logic here) with
 * batched Business/Customer name enrichment for list/usage-log reads — the same "one batched
 * lookup, never N+1" convention every other Super Admin list surface already uses. */
export class SuperAdminPromoService {
  public constructor(
    private readonly promoService: PromoService,
    private readonly redemptionRepository: PromoRedemptionRepository,
    private readonly businessRepository: BusinessRepository,
    private readonly userRepository: UserRepository,
  ) {}

  public async list(
    filter: { status?: "ACTIVE" | "DEACTIVATED" | undefined; q?: string | undefined },
    pagination: { page: number; limit: number },
  ): Promise<SuperAdminPromoListResult> {
    const { promos, total } = await this.promoService.listInternal(filter, pagination);
    return {
      promos: promos.map(toPromoListItemDto),
      pagination: { page: pagination.page, limit: pagination.limit, total },
    };
  }

  public async getById(promoId: string): Promise<PromoDetailDto> {
    const promo = await this.promoService.getById(promoId);
    const businesses =
      promo.businessIds.length > 0
        ? await this.businessRepository.findManyByIds(promo.businessIds)
        : [];
    return {
      ...toPromoListItemDto(promo),
      businesses: businesses.map((b) => ({ id: String(b._id), name: b.name })),
    };
  }

  public async create(
    superAdminUserId: string,
    request: PromoCreateRequest,
  ): Promise<PromoDetailDto> {
    const promo = await this.promoService.create(superAdminUserId, request);
    return this.getById(String(promo._id));
  }

  public async update(promoId: string, request: PromoUpdateRequest): Promise<PromoDetailDto> {
    await this.promoService.update(promoId, request);
    return this.getById(promoId);
  }

  public async setStatus(
    promoId: string,
    status: "ACTIVE" | "DEACTIVATED",
  ): Promise<PromoDetailDto> {
    await this.promoService.setStatus(promoId, status);
    return this.getById(promoId);
  }

  public async delete(promoId: string): Promise<{ outcome: "deleted" | "deactivated" }> {
    return this.promoService.delete(promoId);
  }

  /** Batch 13 — Super Admin Finance's "Discounted money" card (previously a permanent
   * placeholder — see the Batch 13 investigation's own finding). Defined here explicitly:
   * Promo-only (Bookly-funded discounts), never Service.discountPercent (a separate,
   * Business-funded mechanism the investigation confirmed is unrelated) — one reduced ledger
   * sum, never a raw dump. */
  public async getDiscountedMoney(period: { from: Date; to: Date }): Promise<{
    totalCents: number;
    count: number;
    period: { from: string; to: string };
  }> {
    const { totalCents, count } = await this.redemptionRepository.sumDiscountInRange(
      period.from,
      period.to,
    );
    return {
      totalCents,
      count,
      period: { from: period.from.toISOString(), to: period.to.toISOString() },
    };
  }

  public async listRedemptions(
    promoId: string,
    pagination: { page: number; limit: number },
  ): Promise<SuperAdminPromoRedemptionListResult> {
    const { redemptions, total } = await this.redemptionRepository.listByPromoId(
      promoId,
      pagination,
    );

    const customerIds = [...new Set(redemptions.map((r) => String(r.customerUserId)))];
    const businessIds = [...new Set(redemptions.map((r) => String(r.businessId)))];
    const [customers, businesses] = await Promise.all([
      this.userRepository.findManyByIds(customerIds),
      this.businessRepository.findManyByIds(businessIds),
    ]);
    const emailById = new Map(customers.map((u) => [String(u._id), u.normalizedEmail]));
    const businessNameById = new Map(businesses.map((b) => [String(b._id), b.name]));

    return {
      redemptions: redemptions.map((r) =>
        toPromoRedemptionRowDto(
          r,
          emailById.get(String(r.customerUserId)) ?? "—",
          businessNameById.get(String(r.businessId)) ?? "—",
        ),
      ),
      pagination: { page: pagination.page, limit: pagination.limit, total },
    };
  }
}
