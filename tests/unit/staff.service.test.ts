import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";

import type { BusinessDocument } from "../../src/modules/business/business.model.js";
import type { BusinessRepository } from "../../src/modules/business/business.repository.js";
import type { StaffMembershipDocument } from "../../src/modules/staff/staff.model.js";
import type { StaffRepository } from "../../src/modules/staff/staff.repository.js";
import { StaffService } from "../../src/modules/staff/staff.service.js";
import type { StaffScheduleRepository } from "../../src/modules/staff/staff-schedule.repository.js";
import type { StaffTimeOffRepository } from "../../src/modules/staff/staff-time-off.repository.js";
import type { StaffAvatarService } from "../../src/modules/staff-avatar/staff-avatar.service.js";
import type { StaffInvitationService } from "../../src/modules/staff-invitation/staff-invitation.service.js";
import type { UserDocument, UserProfileDocument } from "../../src/modules/user/user.model.js";
import type { UserRepository } from "../../src/modules/user/user.repository.js";

const buildBusiness = (overrides: Partial<BusinessDocument> = {}): BusinessDocument =>
  ({
    _id: new Types.ObjectId(),
    ownerUserId: new Types.ObjectId(),
    name: "Bookly Studio",
    ownerName: "Owner Name",
    email: "owner@example.com",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  }) as BusinessDocument;

const buildUser = (overrides: Partial<UserDocument> = {}): UserDocument =>
  ({
    _id: new Types.ObjectId(),
    normalizedEmail: "person@example.com",
    role: "STAFF",
    status: "ACTIVE",
    ...overrides,
  }) as UserDocument;

const buildProfile = (userId: Types.ObjectId): UserProfileDocument =>
  ({
    _id: new Types.ObjectId(),
    userId,
    firstName: "Pat",
    lastName: "Doe",
    gender: "other",
  }) as UserProfileDocument;

const buildMembership = (
  overrides: Partial<StaffMembershipDocument> = {},
): StaffMembershipDocument =>
  ({
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    businessId: new Types.ObjectId(),
    role: "STAFF",
    employmentActive: true,
    createdByUserId: new Types.ObjectId(),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  }) as StaffMembershipDocument;

describe("StaffService.listStaff — avatar integration", () => {
  it("attaches avatarUrl to both the Owner row and membership rows via a single batched lookup", async () => {
    const ownerUserId = new Types.ObjectId();
    const business = buildBusiness({ ownerUserId });
    const staffUserId = new Types.ObjectId();
    const membership = buildMembership({ businessId: business._id, userId: staffUserId });

    const ownerUser = buildUser({ _id: ownerUserId, normalizedEmail: business.email });
    const staffUser = buildUser({ _id: staffUserId });
    const ownerProfile = buildProfile(ownerUserId);
    const staffProfile = buildProfile(staffUserId);

    const staffRepository = {
      listActiveByBusinessId: vi.fn().mockResolvedValue([membership]),
    } as unknown as StaffRepository;
    const businessRepository = {
      findById: vi.fn().mockResolvedValue(business),
    } as unknown as BusinessRepository;
    const userRepository = {
      findManyByIds: vi.fn().mockResolvedValue([ownerUser, staffUser]),
      findProfilesByUserIds: vi.fn().mockResolvedValue([ownerProfile, staffProfile]),
    } as unknown as UserRepository;
    const staffScheduleRepository = {
      findManyByMembershipIds: vi.fn().mockResolvedValue([]),
    } as unknown as StaffScheduleRepository;
    const staffTimeOffRepository = {
      findManyByMembershipIds: vi.fn().mockResolvedValue([]),
    } as unknown as StaffTimeOffRepository;

    const avatarUrlByUserId = new Map<string, string>([
      [String(ownerUserId), "https://signed.example/users/owner/avatar.png"],
      [String(staffUserId), "https://signed.example/users/staff/avatar.png"],
    ]);
    const getAvatarUrlsByUserIds = vi.fn().mockResolvedValue(avatarUrlByUserId);
    const staffAvatarService = {
      getAvatarUrlsByUserIds,
    } as unknown as StaffAvatarService;

    const staffInvitationService = {
      listPendingForBusiness: vi.fn().mockResolvedValue([]),
    } as unknown as StaffInvitationService;

    const service = new StaffService(
      staffRepository,
      businessRepository,
      userRepository,
      staffInvitationService,
      {} as never,
      staffScheduleRepository,
      staffTimeOffRepository,
      staffAvatarService,
    );

    const result = await service.listStaff(String(ownerUserId), String(business._id));

    // Exactly one batched avatar lookup per listStaff call, regardless of staff count —
    // never one call per row.
    expect(getAvatarUrlsByUserIds).toHaveBeenCalledTimes(1);
    expect(getAvatarUrlsByUserIds).toHaveBeenCalledWith([String(ownerUserId), String(staffUserId)]);

    const ownerRow = result.members.find((member) => member.isOwner);
    const staffRow = result.members.find((member) => !member.isOwner);

    expect(ownerRow?.avatarUrl).toBe("https://signed.example/users/owner/avatar.png");
    expect(staffRow?.avatarUrl).toBe("https://signed.example/users/staff/avatar.png");
  });
});
