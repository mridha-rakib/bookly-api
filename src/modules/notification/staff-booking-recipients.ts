import type { Types } from "mongoose";

import type { BookingDocument } from "../booking/booking.model.js";
import { normalizeRecipient } from "./notification-recipients.js";

/**
 * Resolves the DISTINCT staff members assigned to a booking (each service line's
 * `responsibleStaffMembershipId`) down to `{ email, firstName, membershipIds, services }` —
 * every value from persisted, authoritative data, never recomputed. Used by the staff booking
 * notifiers so a schedule-change / cancellation email reaches ONLY the actually-assigned staff.
 *
 * A membership whose email cannot be resolved from the User model is dropped (STOP-condition:
 * "staff email is already available from authoritative data") — the caller logs the skip.
 * De-dupes by normalized email so one person covering two lines gets one email listing both
 * services.
 */
export type StaffMembershipLookupPort = {
  /** Returns memberships for the given ids scoped to the business — INCLUDING soft-removed ones,
   * so a booking that references a since-removed staff member can still be resolved. */
  findManyByIdsForBusiness(
    businessId: Types.ObjectId | string,
    ids: Array<Types.ObjectId | string>,
  ): Promise<Array<{ _id: unknown; userId: unknown }>>;
};

export type StaffRecipientUserPort = {
  findManyByIds(
    ids: Array<Types.ObjectId | string>,
  ): Promise<Array<{ _id: unknown; normalizedEmail: string }>>;
  findProfilesByUserIds(
    ids: string[],
  ): Promise<Array<{ userId: unknown; firstName: string; lastName: string }>>;
};

export type AssignedStaffRecipient = {
  email: string;
  firstName: string;
  /** All service-line membership ids that resolved to this recipient (usually one). */
  membershipIds: string[];
  /** Distinct service names this recipient is responsible for on the booking. */
  services: string[];
};

export const resolveAssignedStaffRecipients = async (
  booking: BookingDocument,
  staffPort: StaffMembershipLookupPort,
  userPort: StaffRecipientUserPort,
): Promise<AssignedStaffRecipient[]> => {
  const servicesByMembershipId = new Map<string, string[]>();
  for (const line of booking.serviceLines) {
    const key = String(line.responsibleStaffMembershipId);
    const bucket = servicesByMembershipId.get(key) ?? [];
    bucket.push(line.serviceSnapshot.name);
    servicesByMembershipId.set(key, bucket);
  }

  const membershipIds = [...servicesByMembershipId.keys()];
  if (membershipIds.length === 0) {
    return [];
  }

  const memberships = await staffPort.findManyByIdsForBusiness(booking.businessId, membershipIds);
  const userIdByMembershipId = new Map(
    memberships.map((membership) => [String(membership._id), String(membership.userId)]),
  );
  const userIds = [...new Set([...userIdByMembershipId.values()])];
  if (userIds.length === 0) {
    return [];
  }

  const [users, profiles] = await Promise.all([
    userPort.findManyByIds(userIds),
    userPort.findProfilesByUserIds(userIds),
  ]);
  const emailByUserId = new Map(users.map((user) => [String(user._id), user.normalizedEmail]));
  const firstNameByUserId = new Map(
    profiles.map((profile) => [String(profile.userId), profile.firstName]),
  );

  const byEmail = new Map<string, AssignedStaffRecipient>();
  for (const membershipId of membershipIds) {
    const userId = userIdByMembershipId.get(membershipId);
    if (!userId) {
      continue;
    }
    const email = normalizeRecipient(emailByUserId.get(userId) ?? "");
    if (!email) {
      continue;
    }
    const lineServices = servicesByMembershipId.get(membershipId) ?? [];
    const existing = byEmail.get(email);
    if (existing) {
      existing.membershipIds.push(membershipId);
      for (const service of lineServices) {
        if (!existing.services.includes(service)) {
          existing.services.push(service);
        }
      }
      continue;
    }
    byEmail.set(email, {
      email,
      firstName: firstNameByUserId.get(userId) || "there",
      membershipIds: [membershipId],
      services: [...new Set(lineServices)],
    });
  }

  return [...byEmail.values()];
};
