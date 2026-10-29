import { Error as MongooseError, mongo } from "mongoose";
import { BookingModel } from "../booking/booking.model.js";
import { BookingCreationClaimModel } from "../booking/booking-creation-claim.model.js";
import { verifyPackagePurchaseClaimCompletion } from "../booking/package-purchase-authority.js";
import { BusinessModel } from "../business/business.model.js";
import { StaffMembershipModel } from "../staff/staff.model.js";
import { toCustomerPackageView } from "./package-customer-view.js";
import { readPackageOperationViews } from "./package-operation-view.js";
import { PackageProgressError } from "./package-progress.errors.js";
import { PackageProgressV2Model } from "./package-progress-v2.model.js";
import type { PackageProgressV2Document } from "./package-progress-v2.types.js";

/**
 * P2A — commercial purchase state of a first-class Progress. A V2 row is written at INTERNAL
 * materialization (`commercialCompletion: "NOT_ESTABLISHED"`), before payment/finance
 * completion, and can never be deleted. Only the same read-only authority that gates REDEEM
 * plus the genuine production-proof authority may report VERIFIED; anything unproven is NOT_ESTABLISHED. Database
 * failures are not swallowed (the route maps them to 503).
 */
export type PackagePurchaseCompletion = "VERIFIED" | "NOT_ESTABLISHED";

export const readPackagePurchaseCompletion = async (
  progress: Pick<PackageProgressV2Document, "_id" | "businessId" | "customerUserId">,
): Promise<PackagePurchaseCompletion> => {
  const claim = await BookingCreationClaimModel.findOne({
    "packageBatchPreparation.packageProgressId": progress._id,
    businessId: progress.businessId,
    actorUserId: progress.customerUserId,
  })
    .read("primary")
    .maxTimeMS(2000)
    .exec();
  if (!claim) return "NOT_ESTABLISHED";
  try {
    await verifyPackagePurchaseClaimCompletion(claim);
    return "VERIFIED";
  } catch (error) {
    // Storage failures surface (503 via the route). Every other verification failure —
    // conflict, unresolved, malformed/tampered proof (schema errors) — is simply unproven.
    if (
      error instanceof mongo.MongoError ||
      error instanceof MongooseError.MongooseServerSelectionError
    )
      throw error;
    return "NOT_ESTABLISHED";
  }
};

export class PackageViewService {
  public async owned(customerId: string, progressId?: string, before?: string) {
    const records = await PackageProgressV2Model.find({
      customerUserId: customerId,
      schemaVersion: 2,
      ...(progressId ? { _id: progressId } : before ? { _id: { $lt: before } } : {}),
    })
      .sort({ _id: -1 })
      .limit(51)
      .maxTimeMS(2000)
      .exec();
    if (progressId && !records.length)
      throw new PackageProgressError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    const selected = records.slice(0, 50);
    const bookings = selected.length
      ? await BookingModel.find({
          $or: selected.map((progress) => ({
            businessId: progress.businessId,
            "customer.customerUserId": customerId,
            "customer.businessClientId": progress.businessClientId,
            _id: { $in: [progress.originBookingId, ...progress.sessions.map((s) => s.bookingId)] },
          })),
        })
          .maxTimeMS(2000)
          .exec()
      : [];
    const packages = await Promise.all(
      selected.map(async (progress) => {
        return {
          ...toCustomerPackageView(progress, bookings),
          purchaseCompletion: await readPackagePurchaseCompletion(progress),
          ...(progressId ? await readPackageOperationViews(progress) : {}),
        };
      }),
    );
    return {
      packages,
      hasMore: records.length > 50,
      nextCursor: records.length > 50 ? String(selected[selected.length - 1]!._id) : null,
    };
  }

  public async settlement(actorId: string, role: string, businessId: string, bookingId: string) {
    const business = await BusinessModel.findById(businessId).maxTimeMS(2000).exec();
    const owner = role === "BUSINESS_OWNER" && String(business?.ownerUserId) === actorId;
    const supervisor =
      role === "SUPERVISOR" &&
      (await StaffMembershipModel.exists({
        businessId,
        userId: actorId,
        role: "SUPERVISOR",
        employmentActive: true,
        removedAt: { $eq: null },
      }).maxTimeMS(2000));
    if (!business || !["APPROVED", "WARNING"].includes(business.status) || (!owner && !supervisor))
      throw new PackageProgressError("PACKAGE_SETTLEMENT_FORBIDDEN", 403);
    const booking = await BookingModel.findOne({ _id: bookingId, businessId })
      .maxTimeMS(2000)
      .exec();
    const line = booking?.serviceLines.find((l) => l.pricingInput.packageItemId);
    if (
      !booking ||
      !line?.pricingInput.packageProgressId ||
      !line.pricingInput.packageItemId ||
      !booking.customer.customerUserId ||
      !booking.customer.businessClientId
    )
      throw new PackageProgressError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    const progress = await PackageProgressV2Model.findOne({
      _id: line.pricingInput.packageProgressId,
      businessId,
      customerUserId: booking.customer.customerUserId,
      businessClientId: booking.customer.businessClientId,
    })
      .maxTimeMS(2000)
      .exec();
    if (
      !progress ||
      !progress.sessions.some(
        (s) =>
          String(s.bookingId) === bookingId &&
          String(s.packageItemId) === String(line.pricingInput.packageItemId) &&
          String(s.serviceId) === String(line.serviceId),
      )
    )
      throw new PackageProgressError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    const bookings = await BookingModel.find({
      _id: { $in: [progress.originBookingId, booking._id] },
      businessId,
      "customer.customerUserId": progress.customerUserId,
      "customer.businessClientId": progress.businessClientId,
    })
      .maxTimeMS(2000)
      .exec();
    const view = toCustomerPackageView(progress, bookings);
    return {
      originBookingId: view.originBookingId,
      packageProgressId: String(progress._id),
      purchaseCompletion: await readPackagePurchaseCompletion(progress),
      purchaseFinancials: view.purchaseFinancials,
      ...(await readPackageOperationViews(progress)),
      session: view.sessions.find((s) => s.bookingId === bookingId) ?? null,
      actionsAvailable: false as const,
    };
  }
}
