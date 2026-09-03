import { Types } from "mongoose";

import { normalizeEmail } from "../../src/modules/auth/auth.utils.js";
import type { StaffRepository } from "../../src/modules/staff/staff.repository.js";
import type { StaffCreatableRole } from "../../src/modules/staff/staff.types.js";
import { splitStaffName } from "../../src/modules/staff/staff.utils.js";
import type { UserRepository } from "../../src/modules/user/user.repository.js";

export type SeededStaffMember = {
  membershipId: string;
  userId: string;
  businessId: string;
  name: string;
  email: string;
  role: StaffCreatableRole;
  employmentActive: boolean;
  isOwner: false;
  createdAt: string;
};

const toObjectId = (value: Types.ObjectId | string): Types.ObjectId =>
  typeof value === "string" ? new Types.ObjectId(value) : value;

/**
 * Phase 2D test fixture — provisions an ACTIVE staff member directly through the repositories,
 * bypassing the invitation round-trip. `StaffService.createStaff` now only issues an invitation
 * (no User until acceptance), so tests that need a *working* SUPERVISOR/STAFF to exercise
 * update / remove / schedule / time-off / access-event use this instead. Mirrors the shape the
 * old `createStaff` returned so those tests stay readable.
 */
export const seedStaffMember = async (
  userRepository: UserRepository,
  staffRepository: StaffRepository,
  ownerUserId: Types.ObjectId | string,
  businessId: Types.ObjectId | string,
  input: { name: string; email: string; role: StaffCreatableRole; phone?: string | undefined },
): Promise<SeededStaffMember> => {
  const normalizedEmail = normalizeEmail(input.email);
  const { firstName, lastName } = splitStaffName(input.name);

  const user = await userRepository.create({
    normalizedEmail,
    passwordHash: "hash",
    authProviders: ["PASSWORD"],
    role: input.role,
    status: "ACTIVE",
  });

  await userRepository.createProfile({
    userId: user._id,
    firstName,
    lastName,
    gender: "other",
  });

  const membership = await staffRepository.create({
    userId: user._id,
    businessId: toObjectId(businessId),
    role: input.role,
    createdByUserId: toObjectId(ownerUserId),
  });

  return {
    membershipId: String(membership._id),
    userId: String(user._id),
    businessId: String(membership.businessId),
    name: input.name,
    email: normalizedEmail,
    role: input.role,
    employmentActive: membership.employmentActive,
    isOwner: false,
    createdAt: membership.createdAt.toISOString(),
  };
};
