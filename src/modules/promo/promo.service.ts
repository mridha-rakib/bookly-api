import { Types } from "mongoose";
import type { BusinessRepository } from "../business/business.repository.js";
import { PromoError } from "./promo.errors.js";
import type { PromoCodeDocument } from "./promo.model.js";
import type { CreatePromoInput, PromoRepository, UpdatePromoInput } from "./promo.repository.js";
import type { PromoScope, PromoType } from "./promo.types.js";
import type { PromoRedemptionRepository } from "./promo-redemption.repository.js";

export type PromoCreateRequest = {
  code: string;
  type: PromoType;
  value: number;
  scope: PromoScope;
  businessIds: string[];
  startAt?: Date | undefined;
  expiresAt: Date;
  totalUsageLimit?: number | undefined;
  perUserUsageLimit?: number | undefined;
};

export type PromoUpdateRequest = {
  code?: string | undefined;
  type?: PromoType | undefined;
  value?: number | undefined;
  scope?: PromoScope | undefined;
  businessIds?: string[] | undefined;
  startAt?: Date | undefined;
  expiresAt?: Date | undefined;
  totalUsageLimit?: number | undefined;
  perUserUsageLimit?: number | undefined;
};

/** Batch 13 — Super Admin Promo Code CRUD. SUPER_ADMIN-only end to end (enforced at the route
 * level, same router-wide-gate pattern every other Super Admin surface uses). Never grants
 * Business Owners promo management (confirmed rule — no Business-scoped authorization path
 * exists here at all, by design). */
export class PromoService {
  public constructor(
    private readonly promoRepository: PromoRepository,
    private readonly businessRepository: BusinessRepository,
    private readonly redemptionRepository: PromoRedemptionRepository,
  ) {}

  public async create(
    superAdminUserId: string,
    request: PromoCreateRequest,
  ): Promise<PromoCodeDocument> {
    const normalizedCode = request.code.trim().toUpperCase();
    const existing = await this.promoRepository.findByNormalizedCode(normalizedCode);
    if (existing) {
      throw new PromoError("PROMO_CODE_ALREADY_EXISTS", 409);
    }

    const businessIds = await this.resolveBusinessIds(request.scope, request.businessIds);
    this.validateValue(request.type, request.value);

    const input: CreatePromoInput = {
      code: request.code.trim(),
      normalizedCode,
      type: request.type,
      value: request.value,
      scope: request.scope,
      businessIds,
      startAt: request.startAt,
      expiresAt: request.expiresAt,
      totalUsageLimit: request.totalUsageLimit,
      perUserUsageLimit: request.perUserUsageLimit,
      createdByUserId: new Types.ObjectId(superAdminUserId),
    };
    return this.promoRepository.create(input);
  }

  public async update(promoId: string, request: PromoUpdateRequest): Promise<PromoCodeDocument> {
    const promo = await this.requirePromo(promoId);

    const update: UpdatePromoInput = {};
    if (request.code !== undefined) {
      const normalizedCode = request.code.trim().toUpperCase();
      if (normalizedCode !== promo.normalizedCode) {
        const existing = await this.promoRepository.findByNormalizedCode(normalizedCode);
        if (existing) {
          throw new PromoError("PROMO_CODE_ALREADY_EXISTS", 409);
        }
      }
      update.code = request.code.trim();
      update.normalizedCode = normalizedCode;
    }
    if (request.type !== undefined || request.value !== undefined) {
      const type = request.type ?? promo.type;
      const value = request.value ?? promo.value;
      this.validateValue(type, value);
      update.type = type;
      update.value = value;
    }
    if (request.scope !== undefined || request.businessIds !== undefined) {
      const scope = request.scope ?? promo.scope;
      const businessIds = await this.resolveBusinessIds(
        scope,
        request.businessIds ?? promo.businessIds.map((id) => String(id)),
      );
      update.scope = scope;
      update.businessIds = businessIds;
    }
    if (request.startAt !== undefined) update.startAt = request.startAt;
    if (request.expiresAt !== undefined) update.expiresAt = request.expiresAt;
    if (request.totalUsageLimit !== undefined) update.totalUsageLimit = request.totalUsageLimit;
    if (request.perUserUsageLimit !== undefined)
      update.perUserUsageLimit = request.perUserUsageLimit;

    const updated = await this.promoRepository.update(promoId, update);
    if (!updated) {
      throw new PromoError("PROMO_NOT_FOUND", 404);
    }
    return updated;
  }

  public async setStatus(
    promoId: string,
    status: "ACTIVE" | "DEACTIVATED",
  ): Promise<PromoCodeDocument> {
    await this.requirePromo(promoId);
    const updated = await this.promoRepository.setStatus(promoId, status);
    if (!updated) {
      throw new PromoError("PROMO_NOT_FOUND", 404);
    }
    return updated;
  }

  /** Rule #17: hard-deleting a Promo with redemption history would destroy financial/audit
   * evidence the ledger/Finance system depends on being permanent — so a Promo with ANY
   * redemption is never actually deleted, only force-deactivated (the safest history-preserving
   * behavior). Only a genuinely unused Promo (zero redemptions) is ever really removed. Returns
   * which outcome occurred so the controller can report it honestly rather than implying a real
   * delete happened when it didn't. */
  public async delete(promoId: string): Promise<{ outcome: "deleted" | "deactivated" }> {
    await this.requirePromo(promoId);
    const redemptionCount = await this.redemptionRepository.countByPromoId(promoId);
    if (redemptionCount > 0) {
      await this.promoRepository.setStatus(promoId, "DEACTIVATED");
      return { outcome: "deactivated" };
    }
    await this.promoRepository.delete(promoId);
    return { outcome: "deleted" };
  }

  public async getById(promoId: string): Promise<PromoCodeDocument> {
    return this.requirePromo(promoId);
  }

  public async listInternal(
    filter: { status?: "ACTIVE" | "DEACTIVATED" | undefined; q?: string | undefined },
    pagination: { page: number; limit: number },
  ): Promise<{ promos: PromoCodeDocument[]; total: number }> {
    return this.promoRepository.list(filter, pagination);
  }

  private async requirePromo(promoId: string): Promise<PromoCodeDocument> {
    if (!Types.ObjectId.isValid(promoId)) {
      throw new PromoError("PROMO_NOT_FOUND", 404);
    }
    const promo = await this.promoRepository.findById(promoId);
    if (!promo) {
      throw new PromoError("PROMO_NOT_FOUND", 404);
    }
    return promo;
  }

  private async resolveBusinessIds(
    scope: PromoScope,
    businessIds: string[],
  ): Promise<Types.ObjectId[]> {
    if (scope !== "SELECTED_BUSINESSES") {
      return [];
    }
    if (businessIds.length === 0) {
      throw new PromoError("PROMO_INVALID", 400, [
        {
          message: "SELECTED_BUSINESSES scope requires at least one business",
          code: "PROMO_INVALID",
        },
      ]);
    }
    const businesses = await this.businessRepository.findManyByIds(businessIds);
    if (businesses.length !== new Set(businessIds).size) {
      throw new PromoError("PROMO_INVALID", 400, [
        { message: "One or more selected businesses do not exist", code: "PROMO_INVALID" },
      ]);
    }
    return businesses.map((b) => b._id);
  }

  private validateValue(type: PromoType, value: number): void {
    if (type === "PERCENTAGE" && (value <= 0 || value > 100)) {
      throw new PromoError("PROMO_INVALID", 400, [
        { message: "Percentage value must be between 1 and 100", code: "PROMO_INVALID" },
      ]);
    }
    if (type === "FIXED" && value <= 0) {
      throw new PromoError("PROMO_INVALID", 400, [
        { message: "Fixed value must be greater than 0", code: "PROMO_INVALID" },
      ]);
    }
  }
}
