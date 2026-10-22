import mongoose, { type ClientSession, type Types } from "mongoose";
import { AppError } from "../../common/errors/app-error.js";
import { BusinessModel } from "../business/business.model.js";
import { normalizeBusinessVisitType } from "../business/business.types.js";
import { type ServiceDocument, ServiceModel } from "../services/service.model.js";
import { StaffMembershipModel } from "../staff/staff.model.js";
import { PackageProgressV2Model } from "./package-progress-v2.model.js";
import { packageProgressV2InputSchema } from "./package-progress-v2.rules.js";

export const packageEligibilityError = (
  code = "PACKAGE_DEPENDENCY_OUTSTANDING",
  status = 409,
): AppError =>
  new AppError("Package eligibility conflict", status, {
    expose: true,
    details: [{ code, message: "Purchased Package dependencies must remain redeemable" }],
  });

export const requirePackageTransaction = (session: ClientSession): void => {
  if (!session?.inTransaction()) throw packageEligibilityError("PACKAGE_TRANSACTION_REQUIRED", 503);
};
export const acquirePackageEligibilityFence = async (
  businessId: Types.ObjectId | string,
  session: ClientSession,
): Promise<void> => {
  requirePackageTransaction(session);
  const business = await BusinessModel.findOneAndUpdate(
    {
      _id: businessId,
      $or: [
        { packageEligibilityVersion: { $exists: false } },
        { packageEligibilityVersion: { $lt: Number.MAX_SAFE_INTEGER } },
      ],
    },
    { $inc: { packageEligibilityVersion: 1 } },
    { session, returnDocument: "after", timestamps: false },
  );
  if (!business) throw packageEligibilityError("PACKAGE_ELIGIBILITY_FENCE_UNAVAILABLE");
};

/** Join an existing transaction, or own one with driver's transient-write retry semantics.
 * Work must contain DB operations only; never provider calls or notification side effects. */
export const withPackageEligibility = async <T>(
  businessId: Types.ObjectId | string,
  existing: ClientSession | undefined,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> => {
  if (existing) {
    await acquirePackageEligibilityFence(businessId, existing);
    return work(existing);
  }
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      await acquirePackageEligibilityFence(businessId, session);
      return work(session);
    });
  } finally {
    await session.endSession();
  }
};

export const hasOutstandingPackageItem = async (
  businessId: Types.ObjectId | string,
  serviceId: Types.ObjectId | string | undefined,
  session: ClientSession,
): Promise<boolean> => {
  requirePackageTransaction(session);
  const now = new Date();
  const id = serviceId === undefined ? undefined : new mongoose.Types.ObjectId(String(serviceId));
  const candidates = await PackageProgressV2Model.find({
    businessId,
    schemaVersion: 2,
    voidedAt: { $exists: false },
    $or: [
      {
        items: {
          $elemMatch: { ...(id ? { serviceId: id } : {}), remainingSessions: { $gt: 0 } },
        },
      },
      { sessions: { $elemMatch: { ...(id ? { serviceId: id } : {}), status: "SCHEDULED" } } },
    ],
  })
    .session(session)
    .lean();
  for (const progress of candidates) {
    if (progress.creditAccountingVersion === undefined || progress.creditAccountingVersion === 1)
      return true;
    const { createdAt: _created, updatedAt: _updated, ...input } = progress;
    if (
      !packageProgressV2InputSchema.safeParse(input).success ||
      progress.creditAccountingVersion !== 2
    )
      throw packageEligibilityError("PACKAGE_PROGRESS_INTEGRITY_ERROR");
    if (
      progress.sessions.some(
        (attempt) => attempt.status === "SCHEDULED" && (!id || attempt.serviceId.equals(id)),
      )
    )
      return true;
    const validity = progress.purchasedContract.validity;
    if (validity.mode === "FOREVER" || (!progress.expiryReconciledAt && now < validity.expiresAt))
      return true;
  }
  return false;
};

export const assertServicePackageDependencies = async (
  businessId: Types.ObjectId | string,
  serviceId: Types.ObjectId | string,
  candidate: Pick<
    ServiceDocument,
    "status" | "isPackageDeal" | "pricingMode" | "fixedPricing" | "assignedStaffMembershipIds"
  >,
  session: ClientSession,
): Promise<void> => {
  if (!(await hasOutstandingPackageItem(businessId, serviceId, session))) return;
  if (
    candidate.status === "DRAFT" ||
    candidate.status === "ARCHIVED" ||
    candidate.isPackageDeal ||
    candidate.pricingMode !== "FIXED" ||
    !Number.isSafeInteger(candidate.fixedPricing?.durationMin) ||
    (candidate.fixedPricing?.durationMin ?? 0) < 1
  )
    throw packageEligibilityError();
  const provider = await StaffMembershipModel.exists({
    businessId,
    _id: { $in: candidate.assignedStaffMembershipIds },
    removedAt: { $exists: false },
    employmentActive: true,
    role: { $in: ["STAFF", "SUPERVISOR"] },
  }).session(session);
  if (!provider) throw packageEligibilityError();
};

export const assertStaffPackageDependencies = async (
  businessId: Types.ObjectId | string,
  staffId: Types.ObjectId | string,
  session: ClientSession,
): Promise<void> => {
  const assigned = await ServiceModel.find({
    businessId,
    assignedStaffMembershipIds: staffId,
  }).session(session);
  for (const service of assigned) {
    await assertServicePackageDependencies(
      businessId,
      service._id,
      {
        ...service.toObject(),
        assignedStaffMembershipIds: service.assignedStaffMembershipIds.filter(
          (id) => String(id) !== String(staffId),
        ),
      },
      session,
    );
  }
};

export const assertBusinessPackageMode = async (
  businessId: Types.ObjectId | string,
  nextMode: unknown,
  session: ClientSession,
): Promise<void> => {
  const business = await BusinessModel.findById(businessId).session(session);
  if (
    business &&
    typeof nextMode === "string" &&
    normalizeBusinessVisitType(business.visitType) !==
      normalizeBusinessVisitType(nextMode as typeof business.visitType) &&
    (await hasOutstandingPackageItem(businessId, undefined, session))
  )
    throw packageEligibilityError();
};
