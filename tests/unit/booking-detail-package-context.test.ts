import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";

import type { BookingDocument } from "../../src/modules/booking/booking.model.js";
import { BookingService } from "../../src/modules/booking/booking.service.js";
import type { PackageProgressDocument } from "../../src/modules/package-progress/package-progress.model.js";

const buildService = (
  bookingRepository: {
    findManyByIdsForCustomer: ReturnType<typeof vi.fn>;
  },
  packageProgressRepository: {
    findManyByIdsForCustomerAndBusiness: ReturnType<typeof vi.fn>;
  },
) =>
  new BookingService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    bookingRepository as never,
    packageProgressRepository as never,
  );

const buildBooking = (packageProgressId?: Types.ObjectId): BookingDocument => {
  const businessId = new Types.ObjectId();
  const customerUserId = new Types.ObjectId();
  return {
    _id: new Types.ObjectId(),
    businessId,
    customer: {
      customerUserId,
      businessClientId: new Types.ObjectId(),
    },
    serviceLines: [
      {
        pricingInput: packageProgressId
          ? { packageProgressId, sessionIndex: 1, sessionsInPackage: 3 }
          : {},
      },
    ],
  } as BookingDocument;
};

describe("Business Booking Detail package read context", () => {
  it("performs no PackageProgress query for a normal booking", async () => {
    const bookingRepository = { findManyByIdsForCustomer: vi.fn() };
    const packageProgressRepository = {
      findManyByIdsForCustomerAndBusiness: vi.fn(),
    };
    const service = buildService(bookingRepository, packageProgressRepository);

    await expect(
      service.getPackageProgressContextsForBusinessBooking(buildBooking()),
    ).resolves.toEqual([]);
    expect(packageProgressRepository.findManyByIdsForCustomerAndBusiness).not.toHaveBeenCalled();
    expect(bookingRepository.findManyByIdsForCustomer).not.toHaveBeenCalled();
  });

  it("uses one business+customer-scoped aggregate query and one scoped origin batch", async () => {
    const packageProgressId = new Types.ObjectId();
    const booking = buildBooking(packageProgressId);
    const originBooking = { ...booking, _id: new Types.ObjectId() } as BookingDocument;
    const progress = {
      _id: packageProgressId,
      businessId: booking.businessId,
      customerUserId: booking.customer.customerUserId,
      originBookingId: originBooking._id,
    } as PackageProgressDocument;
    const bookingRepository = {
      findManyByIdsForCustomer: vi.fn().mockResolvedValue([originBooking]),
    };
    const packageProgressRepository = {
      findManyByIdsForCustomerAndBusiness: vi.fn().mockResolvedValue([progress]),
    };
    const service = buildService(bookingRepository, packageProgressRepository);

    const result = await service.getPackageProgressContextsForBusinessBooking(booking);

    expect(packageProgressRepository.findManyByIdsForCustomerAndBusiness).toHaveBeenCalledOnce();
    expect(packageProgressRepository.findManyByIdsForCustomerAndBusiness).toHaveBeenCalledWith(
      [String(packageProgressId)],
      booking.businessId,
      booking.customer.customerUserId,
    );
    expect(bookingRepository.findManyByIdsForCustomer).toHaveBeenCalledWith(
      booking.businessId,
      [String(originBooking._id)],
      booking.customer.customerUserId,
    );
    expect(result).toEqual([{ progress, originBooking }]);
  });

  it("does not expose a context when the scoped PackageProgress query rejects the link", async () => {
    const bookingRepository = { findManyByIdsForCustomer: vi.fn() };
    const packageProgressRepository = {
      findManyByIdsForCustomerAndBusiness: vi.fn().mockResolvedValue([]),
    };
    const service = buildService(bookingRepository, packageProgressRepository);

    await expect(
      service.getPackageProgressContextsForBusinessBooking(buildBooking(new Types.ObjectId())),
    ).resolves.toEqual([]);
    expect(bookingRepository.findManyByIdsForCustomer).not.toHaveBeenCalled();
  });
});
