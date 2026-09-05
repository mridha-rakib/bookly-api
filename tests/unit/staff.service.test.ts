import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";

import type { BusinessDocument } from "../../src/modules/business/business.model.js";
import type { BusinessRepository } from "../../src/modules/business/business.repository.js";
import type { ServiceDocument } from "../../src/modules/services/service.model.js";
import type { ServiceRepository } from "../../src/modules/services/service.repository.js";
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

describe("StaffService — Owner-or-Supervisor read access (Phase 4A)", () => {
  const buildServiceForAuth = (
    findActiveByUserId: ReturnType<typeof vi.fn>,
    business: BusinessDocument,
  ) => {
    const staffRepository = {
      listActiveByBusinessId: vi.fn().mockResolvedValue([]),
      findActiveByUserId,
    } as unknown as StaffRepository;
    const businessRepository = {
      findById: vi.fn().mockResolvedValue(business),
    } as unknown as BusinessRepository;
    const userRepository = {
      findManyByIds: vi.fn().mockResolvedValue([]),
      findProfilesByUserIds: vi.fn().mockResolvedValue([]),
    } as unknown as UserRepository;
    const staffScheduleRepository = {
      findManyByMembershipIds: vi.fn().mockResolvedValue([]),
    } as unknown as StaffScheduleRepository;
    const staffTimeOffRepository = {
      findManyByMembershipIds: vi.fn().mockResolvedValue([]),
    } as unknown as StaffTimeOffRepository;
    const staffInvitationService = {
      listPendingForBusiness: vi.fn().mockResolvedValue([]),
    } as unknown as StaffInvitationService;
    const staffAvatarService = {
      getAvatarUrlsByUserIds: vi.fn().mockResolvedValue(new Map()),
    } as unknown as StaffAvatarService;

    return new StaffService(
      staffRepository,
      businessRepository,
      userRepository,
      staffInvitationService,
      {} as never,
      staffScheduleRepository,
      staffTimeOffRepository,
      staffAvatarService,
    );
  };

  it("listStaff succeeds for an active SUPERVISOR membership of the business (not just the Owner)", async () => {
    const business = buildBusiness();
    const supervisorUserId = new Types.ObjectId();
    const supervisorMembership = buildMembership({
      userId: supervisorUserId,
      businessId: business._id,
      role: "SUPERVISOR",
    });
    const findActiveByUserId = vi.fn().mockResolvedValue(supervisorMembership);
    const service = buildServiceForAuth(findActiveByUserId, business);

    await expect(
      service.listStaff(String(supervisorUserId), String(business._id)),
    ).resolves.toBeDefined();
    expect(findActiveByUserId).toHaveBeenCalledWith(String(supervisorUserId));
  });

  it("listStaff rejects a plain STAFF membership (Supervisor-or-Owner only, not Staff)", async () => {
    const business = buildBusiness();
    const staffUserId = new Types.ObjectId();
    const staffMembership = buildMembership({
      userId: staffUserId,
      businessId: business._id,
      role: "STAFF",
    });
    const findActiveByUserId = vi.fn().mockResolvedValue(staffMembership);
    const service = buildServiceForAuth(findActiveByUserId, business);

    await expect(service.listStaff(String(staffUserId), String(business._id))).rejects.toThrow();
  });

  it("listStaff rejects a SUPERVISOR membership belonging to a DIFFERENT business", async () => {
    const business = buildBusiness();
    const otherBusinessId = new Types.ObjectId();
    const supervisorUserId = new Types.ObjectId();
    const supervisorMembership = buildMembership({
      userId: supervisorUserId,
      businessId: otherBusinessId,
      role: "SUPERVISOR",
    });
    const findActiveByUserId = vi.fn().mockResolvedValue(supervisorMembership);
    const service = buildServiceForAuth(findActiveByUserId, business);

    await expect(
      service.listStaff(String(supervisorUserId), String(business._id)),
    ).rejects.toThrow();
  });

  it("listStaff rejects an actor with no active membership at all and no ownership", async () => {
    const business = buildBusiness();
    const strangerUserId = new Types.ObjectId();
    const findActiveByUserId = vi.fn().mockResolvedValue(null);
    const service = buildServiceForAuth(findActiveByUserId, business);

    await expect(service.listStaff(String(strangerUserId), String(business._id))).rejects.toThrow();
  });
});

describe("StaffService self-service (Phase 4A) — getMySchedule / listMyAssignedServices", () => {
  it("getMySchedule resolves the caller's own membership and returns their schedule", async () => {
    const business = buildBusiness();
    const staffUserId = new Types.ObjectId();
    const membership = buildMembership({ userId: staffUserId, businessId: business._id });

    const staffRepository = {
      findActiveByUserId: vi.fn().mockResolvedValue(membership),
    } as unknown as StaffRepository;
    const staffScheduleRepository = {
      findByMembershipId: vi.fn().mockResolvedValue({
        days: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" }],
      }),
    } as unknown as StaffScheduleRepository;

    const service = new StaffService(
      staffRepository,
      {} as BusinessRepository,
      {} as UserRepository,
      {} as StaffInvitationService,
      {} as never,
      staffScheduleRepository,
      {} as StaffTimeOffRepository,
      {} as StaffAvatarService,
    );

    const schedule = await service.getMySchedule(String(staffUserId), String(business._id));

    expect(schedule).toEqual([{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" }]);
  });

  it("getMySchedule 404s when the caller has no active membership at all", async () => {
    const staffRepository = {
      findActiveByUserId: vi.fn().mockResolvedValue(null),
    } as unknown as StaffRepository;

    const service = new StaffService(
      staffRepository,
      {} as BusinessRepository,
      {} as UserRepository,
      {} as StaffInvitationService,
      {} as never,
      {} as StaffScheduleRepository,
      {} as StaffTimeOffRepository,
      {} as StaffAvatarService,
    );

    await expect(
      service.getMySchedule(String(new Types.ObjectId()), String(new Types.ObjectId())),
    ).rejects.toThrow();
  });

  it("getMySchedule 404s when the caller's membership belongs to a DIFFERENT business than the URL", async () => {
    const membership = buildMembership({ businessId: new Types.ObjectId() });
    const staffRepository = {
      findActiveByUserId: vi.fn().mockResolvedValue(membership),
    } as unknown as StaffRepository;

    const service = new StaffService(
      staffRepository,
      {} as BusinessRepository,
      {} as UserRepository,
      {} as StaffInvitationService,
      {} as never,
      {} as StaffScheduleRepository,
      {} as StaffTimeOffRepository,
      {} as StaffAvatarService,
    );

    await expect(
      service.getMySchedule(String(membership.userId), String(new Types.ObjectId())),
    ).rejects.toThrow();
  });

  it("listMyAssignedServices returns only Services assigned to the caller's own membership", async () => {
    const business = buildBusiness();
    const staffUserId = new Types.ObjectId();
    const membership = buildMembership({ userId: staffUserId, businessId: business._id });
    const assignedService = {
      _id: new Types.ObjectId(),
      name: "Haircut",
      category: "BEAUTY & WELLNESS",
      subcategory: "Hair",
      status: "ACTIVE",
    } as ServiceDocument;

    const staffRepository = {
      findActiveByUserId: vi.fn().mockResolvedValue(membership),
    } as unknown as StaffRepository;
    const listActiveByAssignedStaffMembershipId = vi.fn().mockResolvedValue([assignedService]);
    const serviceRepository = {
      listActiveByAssignedStaffMembershipId,
    } as unknown as ServiceRepository;

    const service = new StaffService(
      staffRepository,
      {} as BusinessRepository,
      {} as UserRepository,
      {} as StaffInvitationService,
      {} as never,
      {} as StaffScheduleRepository,
      {} as StaffTimeOffRepository,
      {} as StaffAvatarService,
      undefined,
      undefined,
      serviceRepository,
    );

    const result = await service.listMyAssignedServices(String(staffUserId), String(business._id));

    expect(listActiveByAssignedStaffMembershipId).toHaveBeenCalledWith(
      membership.businessId,
      membership._id,
    );
    expect(result).toEqual([
      {
        id: String(assignedService._id),
        name: "Haircut",
        category: "BEAUTY & WELLNESS",
        subcategory: "Hair",
        status: "ACTIVE",
      },
    ]);
  });

  it("listMyAssignedServices returns an empty list when no ServiceRepository was wired (not a crash)", async () => {
    const business = buildBusiness();
    const staffUserId = new Types.ObjectId();
    const membership = buildMembership({ userId: staffUserId, businessId: business._id });

    const staffRepository = {
      findActiveByUserId: vi.fn().mockResolvedValue(membership),
    } as unknown as StaffRepository;

    const service = new StaffService(
      staffRepository,
      {} as BusinessRepository,
      {} as UserRepository,
      {} as StaffInvitationService,
      {} as never,
      {} as StaffScheduleRepository,
      {} as StaffTimeOffRepository,
      {} as StaffAvatarService,
    );

    await expect(
      service.listMyAssignedServices(String(staffUserId), String(business._id)),
    ).resolves.toEqual([]);
  });
});
