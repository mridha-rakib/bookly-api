import { Types } from "mongoose";

import type { BookingDocument } from "../booking/booking.model.js";
import type { BookingRepository } from "../booking/booking.repository.js";
import { type PackageProgressDto, toPackageProgressDto } from "./package-progress.dto.js";
import { PackageProgressError } from "./package-progress.errors.js";
import type { PackageProgressDocument } from "./package-progress.model.js";
import type { PackageProgressRepository } from "./package-progress.repository.js";
import { computePackageBalanceSettlement } from "./package-progress.rules.js";

/**
 * Read-only customer self-service surface for Package entitlements ("My Packages"). Session
 * consumption itself lives on BookingCreationService.redeemPackageSession (it needs the full
 * booking-creation machinery — availability, staff eligibility, reservation, notifications —
 * never duplicated here); this service only ever reads, joining each entitlement with its
 * origin Booking's own authoritative settlement facts (never a second payment-status field —
 * see package-progress.rules.ts's own doc comment).
 */
export class PackageProgressService {
  public constructor(
    private readonly packageProgressRepository: PackageProgressRepository,
    private readonly bookingRepository: BookingRepository,
  ) {}

  public async listForCustomer(customerUserId: string): Promise<PackageProgressDto[]> {
    const packages = await this.packageProgressRepository.listForCustomer(customerUserId);
    if (packages.length === 0) {
      return [];
    }

    // Batched per Business (never one query per Package) — origin Bookings live in a
    // Business-scoped collection query (BookingRepository.findManyByIds), so a customer with
    // Packages at several Businesses is resolved with one query per distinct Business, not one
    // per Package.
    const idsByBusiness = new Map<string, Types.ObjectId[]>();
    for (const pkg of packages) {
      const key = String(pkg.businessId);
      const bucket = idsByBusiness.get(key) ?? [];
      bucket.push(pkg.originBookingId);
      idsByBusiness.set(key, bucket);
    }

    const bookingById = new Map<string, BookingDocument>();
    await Promise.all(
      Array.from(idsByBusiness.entries()).map(async ([businessId, bookingIds]) => {
        const bookings = await this.bookingRepository.findManyByIds(businessId, bookingIds);
        for (const booking of bookings) {
          bookingById.set(String(booking._id), booking);
        }
      }),
    );

    return packages.map((pkg) => {
      const originBooking = bookingById.get(String(pkg.originBookingId));
      const settlement = originBooking
        ? computePackageBalanceSettlement(originBooking)
        : { balanceSettled: false, outstandingBalanceCents: 0 };
      return toPackageProgressDto(pkg, settlement);
    });
  }

  public async getForCustomer(
    customerUserId: string,
    packageProgressId: string,
  ): Promise<PackageProgressDto> {
    const progress = await this.requireOwnedPackage(customerUserId, packageProgressId);
    const originBooking = await this.bookingRepository.findById(
      progress.businessId,
      progress.originBookingId,
    );
    const settlement = originBooking
      ? computePackageBalanceSettlement(originBooking)
      : { balanceSettled: false, outstandingBalanceCents: 0 };

    return toPackageProgressDto(progress, settlement);
  }

  private async requireOwnedPackage(
    customerUserId: string,
    packageProgressId: string,
  ): Promise<PackageProgressDocument> {
    if (!Types.ObjectId.isValid(packageProgressId)) {
      throw new PackageProgressError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    }

    const progress = await this.packageProgressRepository.findByIdForCustomer(
      packageProgressId,
      customerUserId,
    );

    if (!progress) {
      throw new PackageProgressError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    }

    return progress;
  }
}
