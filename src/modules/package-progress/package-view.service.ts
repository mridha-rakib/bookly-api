import { BookingModel } from "../booking/booking.model.js";
import { BusinessModel } from "../business/business.model.js";
import { StaffMembershipModel } from "../staff/staff.model.js";
import { toCustomerPackageView } from "./package-customer-view.js";
import { readPackageOperationViews } from "./package-operation-view.js";
import { PackageProgressError } from "./package-progress.errors.js";
import { PackageProgressV2Model } from "./package-progress-v2.model.js";

export class PackageViewService {
  public async owned(customerId: string, progressId?: string) {
    const records = await PackageProgressV2Model.find({
      customerUserId: customerId,
      schemaVersion: 2,
      ...(progressId ? { _id: progressId } : {}),
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
          ...(progressId ? await readPackageOperationViews(progress) : {}),
        };
      }),
    );
    return { packages, hasMore: records.length > 50 };
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
      purchaseFinancials: view.purchaseFinancials,
      ...(await readPackageOperationViews(progress)),
      session: view.sessions.find((s) => s.bookingId === bookingId) ?? null,
      actionsAvailable: false as const,
    };
  }
}
