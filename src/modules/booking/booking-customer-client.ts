import { Types } from "mongoose";
import type { BusinessDocument } from "../business/business.model.js";
import type { ClientRepository } from "../client/client.repository.js";
import type { UserRepository } from "../user/user.repository.js";
import { BookingError } from "./booking.errors.js";
import type { BookingFulfilment } from "./booking.model.js";

const isDuplicateKeyError = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === 11000;
/** Shared existing first-Booking resolver, extracted without changing its contact/collision policy. */
export async function resolveCustomerBusinessClient(
  clients: Pick<ClientRepository, "findByBusinessIdAndLinkedUserId" | "create">,
  users: Pick<UserRepository, "findById" | "findProfileByUserId">,
  business: BusinessDocument,
  customerUserId: string,
  fulfilment: BookingFulfilment,
) {
  const existing = await clients.findByBusinessIdAndLinkedUserId(business._id, customerUserId);
  if (existing) {
    return existing;
  }

  const [user, profile] = await Promise.all([
    users.findById(customerUserId),
    users.findProfileByUserId(customerUserId),
  ]);
  if (!user || !profile?.phone) {
    throw new BookingError("BOOKING_CUSTOMER_CLIENT_PROFILE_REQUIRED", 409);
  }

  const travelAddress =
    fulfilment.mode === "TRAVEL_TO_CUSTOMER" ? fulfilment.travelAddress : undefined;

  try {
    return await clients.create({
      businessId: business._id,
      createdByUserId: new Types.ObjectId(customerUserId),
      firstName: profile.firstName,
      lastName: profile.lastName,
      normalizedEmail: user.normalizedEmail,
      phone: profile.phone,
      ...(travelAddress
        ? {
            address: {
              city: travelAddress.city,
              propertyType: travelAddress.propertyType,
              area: travelAddress.area,
              streetName: travelAddress.streetName,
              streetNumber: travelAddress.streetNumber,
              floorUnit: travelAddress.floorUnit,
              aptRoom: travelAddress.aptRoom,
            },
          }
        : {}),
      linkState: "LINKED",
      linkedUserId: new Types.ObjectId(customerUserId),
    });
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    const winner = await clients.findByBusinessIdAndLinkedUserId(business._id, customerUserId);
    if (winner) {
      return winner;
    }

    throw new BookingError("BOOKING_CUSTOMER_CLIENT_CONTACT_CONFLICT", 409);
  }
}
