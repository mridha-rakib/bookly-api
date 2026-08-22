import { Types } from "mongoose";

import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import { BusinessCancellationPolicyError } from "./business-cancellation-policy.errors.js";
import {
  type BusinessCancellationPolicyDocument,
  type CancellationFeeMode,
  type CancellationTier,
  type CancellationTierRule,
  cancellationTiers,
} from "./business-cancellation-policy.model.js";
import type { BusinessCancellationPolicyRepository } from "./business-cancellation-policy.repository.js";

export type CancellationTierRuleDto = {
  tier: CancellationTier;
  mode: CancellationFeeMode;
  percentage?: number | undefined;
};

export type BusinessCancellationPolicyDto = {
  businessId: string;
  /**
   * false when no BusinessCancellationPolicy document exists yet for this Business — a
   * future Cancellation/No-show charging batch must treat that as "not configured" and must
   * never fabricate a default fee. Only becomes true after an explicit successful PUT.
   */
  configured: boolean;
  tiers: CancellationTierRuleDto[];
  noShowPercentage?: number | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export type PutCancellationPolicyInput = {
  tiers: CancellationTierRuleDto[];
  noShowPercentage: number;
};

export class BusinessCancellationPolicyService {
  public constructor(
    private readonly cancellationPolicyRepository: BusinessCancellationPolicyRepository,
    private readonly businessRepository: BusinessRepository,
  ) {}

  public async getPolicy(
    userId: string,
    businessId: string,
  ): Promise<BusinessCancellationPolicyDto> {
    await this.requireOwnedBusiness(userId, businessId);
    const policy = await this.cancellationPolicyRepository.findByBusinessId(businessId);
    return this.toDto(businessId, policy);
  }

  /**
   * Replaces the whole policy in one write, mirroring BusinessHoursService.putOpeningHours —
   * always all five tiers together, never a partial update, matching the fixed five-row
   * Settings UI this persists.
   */
  public async putPolicy(
    userId: string,
    businessId: string,
    input: PutCancellationPolicyInput,
  ): Promise<BusinessCancellationPolicyDto> {
    const business = await this.requireOwnedBusiness(userId, businessId);

    // Defense in depth beyond the Zod schema: keep the last rule per tier, so this can never
    // persist two rules for the same window even if a caller bypasses the schema layer
    // directly against the service (same rationale as BusinessHoursService.putOpeningHours).
    const byTier = new Map<CancellationTier, CancellationTierRule>();
    for (const rule of input.tiers) {
      byTier.set(rule.tier, this.normalizeRule(rule));
    }

    const missing = cancellationTiers.filter((tier) => !byTier.has(tier));
    if (missing.length > 0) {
      throw new BusinessCancellationPolicyError("CANCELLATION_POLICY_MISSING_TIERS", 400, [
        {
          message: `Missing rules for: ${missing.join(", ")}`,
          code: "CANCELLATION_POLICY_MISSING_TIERS",
        },
      ]);
    }

    const orderedTiers = cancellationTiers.map((tier) => {
      const rule = byTier.get(tier);
      if (!rule) {
        throw new BusinessCancellationPolicyError("CANCELLATION_POLICY_MISSING_TIERS", 400);
      }
      return rule;
    });

    const policy = await this.cancellationPolicyRepository.replace(
      business._id,
      orderedTiers,
      input.noShowPercentage,
    );

    return this.toDto(businessId, policy);
  }

  private normalizeRule(rule: CancellationTierRuleDto): CancellationTierRule {
    if (rule.mode === "FREE") {
      return { tier: rule.tier, mode: "FREE" };
    }

    // The Zod boundary already rejects a PERCENTAGE rule with no percentage or one outside
    // [20, 100] before this is ever reached — this is a second, independent enforcement
    // point (never trust that validation happened upstream), not a relaxation of the rule.
    if (rule.percentage === undefined) {
      throw new BusinessCancellationPolicyError("CANCELLATION_POLICY_PERCENTAGE_REQUIRED", 400);
    }

    return { tier: rule.tier, mode: "PERCENTAGE", percentage: rule.percentage };
  }

  // Owner-only, no BusinessAccess fallback, no Supervisor access — same rationale as
  // BusinessHoursService.requireOwnedBusiness: cancellation/no-show fee policy is a Business
  // Profile/settings surface.
  private async requireOwnedBusiness(
    userId: string,
    businessId: string,
  ): Promise<BusinessDocument> {
    if (!Types.ObjectId.isValid(businessId)) {
      throw new BusinessCancellationPolicyError("CANCELLATION_POLICY_BUSINESS_NOT_FOUND", 404);
    }

    const business = await this.businessRepository.findById(businessId);

    if (!business) {
      throw new BusinessCancellationPolicyError("CANCELLATION_POLICY_BUSINESS_NOT_FOUND", 404);
    }

    if (!business.ownerUserId.equals(userId)) {
      throw new BusinessCancellationPolicyError("CANCELLATION_POLICY_BUSINESS_NOT_FOUND", 404);
    }

    return business;
  }

  private toDto(
    businessId: string,
    policy: BusinessCancellationPolicyDocument | null,
  ): BusinessCancellationPolicyDto {
    if (!policy) {
      return { businessId, configured: false, tiers: [] };
    }

    const tierOrder = new Map(cancellationTiers.map((tier, index) => [tier, index]));
    const sortedTiers = [...policy.tiers].sort(
      (a, b) => (tierOrder.get(a.tier) ?? 0) - (tierOrder.get(b.tier) ?? 0),
    );

    return {
      businessId,
      configured: true,
      tiers: sortedTiers.map((rule) => ({
        tier: rule.tier,
        mode: rule.mode,
        percentage: rule.percentage,
      })),
      noShowPercentage: policy.noShowPercentage,
      createdAt: policy.createdAt.toISOString(),
      updatedAt: policy.updatedAt.toISOString(),
    };
  }
}
