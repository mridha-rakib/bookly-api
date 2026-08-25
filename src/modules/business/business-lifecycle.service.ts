import { Types } from "mongoose";

import { BusinessError } from "./business.errors.js";
import type { BusinessDocument } from "./business.model.js";
import type { BusinessRepository } from "./business.repository.js";
import type { BusinessStatus } from "./business.types.js";

/**
 * Batch 11 — the Business status lifecycle: approve/reject/suspend. Every transition is a real,
 * CAS-gated (`BusinessRepository.casUpdateStatus`), audited (appends one `statusHistory` entry)
 * write — never an arbitrary `PATCH status=<anything>` endpoint (none exists). Confirmed product
 * rules this service encodes (see Batch 11's own AskUserQuestion answers, all "Recommended"):
 *  - Reject reuses SUSPENDED (there is no distinct REJECTED status in this schema, and the
 *    existing Super Admin mock's own Reject button already did this before any backend existed).
 *  - A single `approve` action reactivates from ANY non-APPROVED status (PENDING, WARNING, or
 *    SUSPENDED/rejected) — nothing is ever permanently locked out, matching the existing mock's
 *    own "Activate" button, which the investigation found appears "whenever status != Approved."
 *  - WARNING is informational only — this service can still transition INTO/OUT OF it via the
 *    generic approve/suspend actions, but nothing in this batch adds a UI control that sets a
 *    Business to WARNING in the first place (none exists in the current design — see the final
 *    report). It remains a real, listable, filterable status regardless.
 */
export class BusinessLifecycleService {
  public constructor(private readonly businessRepository: BusinessRepository) {}

  /** Idempotent: already-APPROVED is a safe no-op, never an error (repeated-click safe). */
  public async approveBusiness(
    superAdminUserId: string,
    businessId: string,
  ): Promise<BusinessDocument> {
    const business = await this.requireBusiness(businessId);
    if (business.status === "APPROVED") {
      return business;
    }

    const updated = await this.businessRepository.casUpdateStatus(
      businessId,
      ["PENDING", "WARNING", "SUSPENDED"],
      "APPROVED",
      {
        fromStatus: business.status,
        actorUserId: new Types.ObjectId(superAdminUserId),
        changedAt: new Date(),
      },
    );

    if (updated) {
      return updated;
    }

    // Lost a genuine race (another actor changed status between our read and the CAS write) —
    // re-check rather than blindly erroring, since "someone else already approved it" is not a
    // real failure from the caller's perspective.
    const fresh = await this.requireBusiness(businessId);
    if (fresh.status === "APPROVED") {
      return fresh;
    }
    throw new BusinessError("BUSINESS_INVALID_STATUS_TRANSITION", 409);
  }

  /** Only valid from PENDING — matches the existing Super Admin Review screen, which only ever
   * offers a Reject action for a Pending application, never for an already-decided Business. */
  public async rejectBusiness(
    superAdminUserId: string,
    businessId: string,
    reason: string | undefined,
  ): Promise<BusinessDocument> {
    const business = await this.requireBusiness(businessId);

    const updated = await this.businessRepository.casUpdateStatus(
      businessId,
      ["PENDING"],
      "SUSPENDED",
      {
        fromStatus: business.status,
        actorUserId: new Types.ObjectId(superAdminUserId),
        reason,
        changedAt: new Date(),
      },
    );

    if (!updated) {
      throw new BusinessError("BUSINESS_INVALID_STATUS_TRANSITION", 409);
    }
    return updated;
  }

  /** Only valid from APPROVED or WARNING — mirrors the existing mock's own "Suspend" button,
   * shown only for an Approved Business. Idempotent: already-SUSPENDED is a safe no-op. */
  public async suspendBusiness(
    superAdminUserId: string,
    businessId: string,
    reason: string | undefined,
  ): Promise<BusinessDocument> {
    const business = await this.requireBusiness(businessId);
    if (business.status === "SUSPENDED") {
      return business;
    }

    const updated = await this.businessRepository.casUpdateStatus(
      businessId,
      ["APPROVED", "WARNING"],
      "SUSPENDED",
      {
        fromStatus: business.status,
        actorUserId: new Types.ObjectId(superAdminUserId),
        reason,
        changedAt: new Date(),
      },
    );

    if (updated) {
      return updated;
    }

    const fresh = await this.requireBusiness(businessId);
    if (fresh.status === "SUSPENDED") {
      return fresh;
    }
    throw new BusinessError("BUSINESS_INVALID_STATUS_TRANSITION", 409);
  }

  private async requireBusiness(businessId: string): Promise<BusinessDocument> {
    if (!Types.ObjectId.isValid(businessId)) {
      throw new BusinessError("BUSINESS_NOT_FOUND", 404);
    }
    const business = await this.businessRepository.findById(businessId);
    if (!business) {
      throw new BusinessError("BUSINESS_NOT_FOUND", 404);
    }
    return business;
  }
}

export type { BusinessStatus };
