import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { EmailOutboxModel } from "../../../src/modules/email-outbox/email-outbox.model.js";
import { EmailOutboxRepository } from "../../../src/modules/email-outbox/email-outbox.repository.js";
import { EmailOutboxService } from "../../../src/modules/email-outbox/email-outbox.service.js";
import { StaffAccessNotifier } from "../../../src/modules/notification/staff-access.notifier.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffService } from "../../../src/modules/staff/staff.service.js";
import { StaffAccessEventModel } from "../../../src/modules/staff/staff-access-event.model.js";
import { StaffAccessEventRepository } from "../../../src/modules/staff/staff-access-event.repository.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../../../src/modules/staff/staff-time-off.repository.js";
import { StaffAvatarRepository } from "../../../src/modules/staff-avatar/staff-avatar.repository.js";
import { StaffAvatarService } from "../../../src/modules/staff-avatar/staff-avatar.service.js";
import { StaffInvitationRepository } from "../../../src/modules/staff-invitation/staff-invitation.repository.js";
import { StaffInvitationService } from "../../../src/modules/staff-invitation/staff-invitation.service.js";
import { createDeferredStorageServiceFromEnv } from "../../../src/modules/storage/storage.service.js";
import { UserModel } from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import type { EmailOtpProvider } from "../../../src/modules/verification/email-otp.provider.js";
import { seedStaffMember } from "../../helpers/seed-staff.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/**
 * STAFF ACCESS CHANGE HISTORY + EMAIL — the reason the `StaffAccessEvent` model exists:
 * a repeatable role flip or activate/deactivate cycle now has a STABLE per-change identity, so
 * each legitimate change persists exactly one event + enqueues exactly one email, while a
 * retried notifier call for the same event stays deduped. Also proves the no-op cases write
 * nothing, and that a failed transaction leaves neither an event nor an email row.
 */

const noopOtpProvider: EmailOtpProvider = {
  async sendOtp() {},
  async sendNotice() {},
};

describe("StaffAccessEvent + access-change email integration", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let staffRepository: StaffRepository;
  let staffService: StaffService;
  let outbox: EmailOutboxService;
  let eventRepository: StaffAccessEventRepository;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    staffRepository = new StaffRepository();
    outbox = new EmailOutboxService(new EmailOutboxRepository());
    eventRepository = new StaffAccessEventRepository();

    const staffAvatarService = new StaffAvatarService(
      new StaffAvatarRepository(),
      businessRepository,
      staffRepository,
      createDeferredStorageServiceFromEnv(),
      { maxUploadBytes: 5 * 1024 * 1024 },
    );

    staffService = new StaffService(
      staffRepository,
      businessRepository,
      userRepository,
      new StaffInvitationService(new StaffInvitationRepository(), userRepository),
      noopOtpProvider,
      new StaffScheduleRepository(),
      new StaffTimeOffRepository(),
      staffAvatarService,
      new StaffAccessNotifier(outbox, userRepository),
      eventRepository,
    );
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const seed = async () => {
    const owner = await userRepository.create({
      normalizedEmail: "owner@example.com",
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const business = await businessRepository.create({
      ownerUserId: owner._id,
      name: "Soho Vintage Barbers",
      ownerName: "Blake Owner",
      email: "biz@example.com",
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: "AT_BUSINESS_LOCATION",
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      briefDescription: "A great barbershop",
      category: "Wellness",
      subcategories: ["Barber"],
    } as never);
    const staff = await seedStaffMember(userRepository, staffRepository, owner._id, business._id, {
      name: "Sam Cutter",
      email: "sam@example.com",
      role: "STAFF",
    });
    return { ownerId: String(owner._id), businessId: String(business._id), staff };
  };

  const rows = () => EmailOutboxModel.find({}).sort({ createdAt: 1 }).lean();
  const events = (membershipId: string) =>
    StaffAccessEventModel.find({ staffMembershipId: membershipId }).sort({ createdAt: 1 }).lean();

  it("STAFF -> SUPERVISOR persists the role, one ROLE_CHANGED event, one email; retried notifier stays one", async () => {
    const { ownerId, businessId, staff } = await seed();

    const updated = await staffService.updateStaff(
      ownerId,
      businessId,
      staff.membershipId as string,
      {
        role: "SUPERVISOR",
      },
    );
    expect(updated.role).toBe("SUPERVISOR");
    // User.role dual-write preserved
    expect((await UserModel.findById(staff.userId).lean())?.role).toBe("SUPERVISOR");

    const evs = await events(staff.membershipId as string);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: "ROLE_CHANGED",
      previousRole: "STAFF",
      newRole: "SUPERVISOR",
      changedByUserId: expect.anything(),
    });

    // Re-dispatching the SAME persisted event must not add a second row.
    await new StaffAccessNotifier(outbox, userRepository).notifyStaffAccessChanged({
      eventId: String(evs[0]?._id),
      type: "ROLE_CHANGED",
      staffUserId: staff.userId,
      businessName: "Soho Vintage Barbers",
      previousRole: "STAFF",
      newRole: "SUPERVISOR",
    });

    const outboxRows = await rows();
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({
      templateKey: "STAFF_ROLE_CHANGED",
      recipient: "sam@example.com",
      status: "PENDING",
      eventKey: `STAFF_ROLE_CHANGED:${String(evs[0]?._id)}`,
    });
    const json = JSON.stringify(outboxRows).toLowerCase();
    for (const forbidden of ["password", "otp", "token", "secret"]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("each STAFF<->SUPERVISOR flip is a NEW event and a NEW email row", async () => {
    const { ownerId, businessId, staff } = await seed();
    const id = staff.membershipId as string;

    await staffService.updateStaff(ownerId, businessId, id, { role: "SUPERVISOR" });
    await staffService.updateStaff(ownerId, businessId, id, { role: "STAFF" });
    await staffService.updateStaff(ownerId, businessId, id, { role: "SUPERVISOR" });

    const evs = await events(id);
    expect(evs.map((e) => `${e.previousRole}->${e.newRole}`)).toEqual([
      "STAFF->SUPERVISOR",
      "SUPERVISOR->STAFF",
      "STAFF->SUPERVISOR",
    ]);
    expect(new Set(evs.map((e) => String(e._id))).size).toBe(3);

    const outboxRows = await rows();
    expect(outboxRows).toHaveLength(3);
    expect(outboxRows.every((r) => r.templateKey === "STAFF_ROLE_CHANGED")).toBe(true);
    expect(new Set(outboxRows.map((r) => r.eventKey)).size).toBe(3);
  });

  it("no-op role (STAFF -> STAFF) writes no event and no email", async () => {
    const { ownerId, businessId, staff } = await seed();
    await staffService.updateStaff(ownerId, businessId, staff.membershipId as string, {
      role: "STAFF",
    });
    expect(await events(staff.membershipId as string)).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("employmentActive true->false->true yields one DEACTIVATED then one REACTIVATED event + one email each", async () => {
    const { ownerId, businessId, staff } = await seed();
    const id = staff.membershipId as string;

    const deactivated = await staffService.updateStaff(ownerId, businessId, id, {
      employmentActive: false,
    });
    expect(deactivated.employmentActive).toBe(false);

    const reactivated = await staffService.updateStaff(ownerId, businessId, id, {
      employmentActive: true,
    });
    expect(reactivated.employmentActive).toBe(true);

    const evs = await events(id);
    expect(evs.map((e) => e.type)).toEqual(["DEACTIVATED", "REACTIVATED"]);
    expect(evs[0]).toMatchObject({ previousEmploymentActive: true, newEmploymentActive: false });
    expect(evs[1]).toMatchObject({ previousEmploymentActive: false, newEmploymentActive: true });

    const outboxRows = await rows();
    expect(outboxRows.map((r) => r.templateKey)).toEqual([
      "STAFF_DEACTIVATED",
      "STAFF_REACTIVATED",
    ]);
    expect(outboxRows.map((r) => r.eventKey)).toEqual([
      `STAFF_DEACTIVATED:${String(evs[0]?._id)}`,
      `STAFF_REACTIVATED:${String(evs[1]?._id)}`,
    ]);
  });

  it("repeated deactivate/reactivate cycles each produce their own event + email", async () => {
    const { ownerId, businessId, staff } = await seed();
    const id = staff.membershipId as string;

    for (const active of [false, true, false, true]) {
      await staffService.updateStaff(ownerId, businessId, id, { employmentActive: active });
    }

    const evs = await events(id);
    expect(evs.map((e) => e.type)).toEqual([
      "DEACTIVATED",
      "REACTIVATED",
      "DEACTIVATED",
      "REACTIVATED",
    ]);
    expect(await rows()).toHaveLength(4);
  });

  it("no-op employmentActive (true->true, false->false) writes no event and no email", async () => {
    const { ownerId, businessId, staff } = await seed();
    const id = staff.membershipId as string;

    await staffService.updateStaff(ownerId, businessId, id, { employmentActive: true }); // already active
    await staffService.updateStaff(ownerId, businessId, id, { employmentActive: false });
    await staffService.updateStaff(ownerId, businessId, id, { employmentActive: false }); // already inactive

    const evs = await events(id);
    expect(evs.map((e) => e.type)).toEqual(["DEACTIVATED"]);
    expect(await rows()).toHaveLength(1);
  });

  it("a missing recipient email does not roll back the change — event persists, no email row", async () => {
    const { ownerId, businessId, staff } = await seed();
    await UserModel.updateOne({ _id: staff.userId }, { $unset: { normalizedEmail: "" } });

    const updated = await staffService.updateStaff(
      ownerId,
      businessId,
      staff.membershipId as string,
      {
        role: "SUPERVISOR",
      },
    );
    expect(updated.role).toBe("SUPERVISOR");
    expect(await events(staff.membershipId as string)).toHaveLength(1);
    expect(await rows()).toHaveLength(0);
  });

  it("event-repo insert failure rolls the role change back (same transaction) and enqueues nothing", async () => {
    const { ownerId, businessId, staff } = await seed();

    const failingEventRepo = {
      create: async () => {
        throw new Error("simulated event insert failure");
      },
      listByMembershipId: async () => [],
    } as unknown as StaffAccessEventRepository;

    const serviceWithFailingRepo = new StaffService(
      staffRepository,
      businessRepository,
      userRepository,
      new StaffInvitationService(new StaffInvitationRepository(), userRepository),
      noopOtpProvider,
      new StaffScheduleRepository(),
      new StaffTimeOffRepository(),
      new StaffAvatarService(
        new StaffAvatarRepository(),
        businessRepository,
        staffRepository,
        createDeferredStorageServiceFromEnv(),
        { maxUploadBytes: 5 * 1024 * 1024 },
      ),
      new StaffAccessNotifier(outbox, userRepository),
      failingEventRepo,
    );

    await expect(
      serviceWithFailingRepo.updateStaff(ownerId, businessId, staff.membershipId as string, {
        role: "SUPERVISOR",
      }),
    ).rejects.toThrow();

    // Role stayed STAFF on BOTH documents; no event; no email.
    expect(
      (await staffRepository.findActiveById(businessId, staff.membershipId as string))?.role,
    ).toBe("STAFF");
    expect((await UserModel.findById(staff.userId).lean())?.role).toBe("STAFF");
    expect(await events(staff.membershipId as string)).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });
});
