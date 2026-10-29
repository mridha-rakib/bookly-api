import type { ClientSession, Types } from "mongoose";
import { withPackageEligibility } from "../package-progress/package-eligibility.js";
import { StaffMembershipModel } from "../staff/staff.model.js";
import { BookingError } from "./booking.errors.js";
import type { BookingActor } from "./booking.model.js";

/** Persistence revalidation, in addition to entry authorization. Supervisor ordinary Booking
 * writes share the Business fence used by deactivation/removal/role changes. A deactivation
 * that wins that fence forces a stale transaction to retry and recheck membership. Owner,
 * Customer, Admin and system writers retain their existing contracts. This grants no access. */
export async function withSupervisorBookingWrite<T>(
  businessId: Types.ObjectId | string,
  actor: BookingActor | undefined,
  session: ClientSession | undefined,
  work: (transaction: ClientSession | undefined) => Promise<T>,
): Promise<T> {
  if (actor?.actorRole !== "SUPERVISOR") return work(session);
  return withPackageEligibility(businessId, session, async (transaction) => {
    if (
      !(await StaffMembershipModel.exists({
        userId: actor.actorUserId,
        businessId,
        role: "SUPERVISOR",
        employmentActive: true,
        removedAt: null,
      }).session(transaction))
    )
      throw new BookingError("BOOKING_BUSINESS_NOT_FOUND", 404);
    return work(transaction);
  });
}
