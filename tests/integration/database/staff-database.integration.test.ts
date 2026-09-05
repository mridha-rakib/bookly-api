import express from "express";
import mongoose, { type Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../../../src/modules/auth/auth.middleware.js";
import { AuthService } from "../../../src/modules/auth/auth.service.js";
import { Argon2PasswordHasher } from "../../../src/modules/auth/password-hasher.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessService } from "../../../src/modules/business/business.service.js";
import { BusinessAccessRepository } from "../../../src/modules/business/business-access.repository.js";
import { BusinessLinkVerificationRepository } from "../../../src/modules/business/business-link-verification.repository.js";
import { BusinessMediaRepository } from "../../../src/modules/business-media/business-media.repository.js";
import { BusinessMediaService } from "../../../src/modules/business-media/business-media.service.js";
import { BusinessOnboardingRepository } from "../../../src/modules/business-onboarding/business-onboarding.repository.js";
import { BusinessOnboardingService } from "../../../src/modules/business-onboarding/business-onboarding.service.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { ClientIdentityService } from "../../../src/modules/client/client-identity.service.js";
import { ContactChangeChallengeRepository } from "../../../src/modules/contact-change/contact-change-challenge.repository.js";
import { LinkedAccountRepository } from "../../../src/modules/linked-account/linked-account.repository.js";
import { RegistrationSessionRepository } from "../../../src/modules/registration-session/registration-session.repository.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffMembershipModel } from "../../../src/modules/staff/staff.model.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import {
  createStaffRoute,
  createStaffScheduleRoute,
} from "../../../src/modules/staff/staff.route.js";
import { StaffService } from "../../../src/modules/staff/staff.service.js";
import { StaffScheduleModel } from "../../../src/modules/staff/staff-schedule.model.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { StaffTimeOffModel } from "../../../src/modules/staff/staff-time-off.model.js";
import { StaffTimeOffRepository } from "../../../src/modules/staff/staff-time-off.repository.js";
import { StaffAvatarRepository } from "../../../src/modules/staff-avatar/staff-avatar.repository.js";
import { StaffAvatarService } from "../../../src/modules/staff-avatar/staff-avatar.service.js";
import { StaffInvitationModel } from "../../../src/modules/staff-invitation/staff-invitation.model.js";
import { StaffInvitationRepository } from "../../../src/modules/staff-invitation/staff-invitation.repository.js";
import { StaffInvitationService } from "../../../src/modules/staff-invitation/staff-invitation.service.js";
import { StaffInvitationAcceptService } from "../../../src/modules/staff-invitation/staff-invitation-accept.service.js";
import { createDeferredStorageServiceFromEnv } from "../../../src/modules/storage/storage.service.js";
import { UserModel, UserProfileModel } from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import type {
  EmailOtpProvider,
  EmailOtpPurpose,
} from "../../../src/modules/verification/email-otp.provider.js";
import { seedStaffMember } from "../../helpers/seed-staff.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

type DbIndex = {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
};

const indexesFor = async (model: typeof StaffMembershipModel) =>
  (await model.collection.indexes()) as DbIndex[];

const businessInput = (ownerUserId: Types.ObjectId, name: string) => ({
  ownerUserId,
  name,
  ownerName: "Blake Owner",
  email: `${name.toLowerCase().replace(/\s+/g, "")}@example.com`,
  phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
  visitType: "AT_BUSINESS_LOCATION" as const,
  address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
  briefDescription: "A great business",
  category: "Wellness",
  subcategories: ["Massage"],
});

class CapturingEmailOtpProvider implements EmailOtpProvider {
  public lastCode = "";
  public lastTo = "";
  public lastPurpose: EmailOtpPurpose | undefined;
  public sentCount = 0;
  public shouldFail = false;
  // Phase 2D — the invitation link email goes through `sendNotice`.
  public lastNoticeTo = "";
  public lastNoticeSubject = "";
  public lastNoticeText = "";
  public noticeCount = 0;

  public async sendOtp(input: {
    to: string;
    code: string;
    purpose?: EmailOtpPurpose;
  }): Promise<void> {
    if (this.shouldFail) {
      throw new Error("simulated delivery failure");
    }

    this.lastCode = input.code;
    this.lastTo = input.to;
    this.lastPurpose = input.purpose;
    this.sentCount += 1;
  }

  public async sendNotice(input: { to: string; subject: string; text: string }): Promise<void> {
    if (this.shouldFail) {
      throw new Error("simulated delivery failure");
    }
    this.lastNoticeTo = input.to;
    this.lastNoticeSubject = input.subject;
    this.lastNoticeText = input.text;
    this.noticeCount += 1;
  }
}

describe("database-backed StaffMembership integration", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let businessAccessRepository: BusinessAccessRepository;
  let staffRepository: StaffRepository;
  let staffScheduleRepository: StaffScheduleRepository;
  let staffTimeOffRepository: StaffTimeOffRepository;
  let emailProvider: CapturingEmailOtpProvider;
  let staffService: StaffService;
  let tokenService: TokenService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    businessAccessRepository = new BusinessAccessRepository();
    staffRepository = new StaffRepository();
    staffScheduleRepository = new StaffScheduleRepository();
    staffTimeOffRepository = new StaffTimeOffRepository();
    emailProvider = new CapturingEmailOtpProvider();
    // No StaffAvatar rows are created in these tests, so getAvatarUrlsByUserIds always
    // short-circuits on an empty repository result and never touches the (unconfigured in
    // test) storage service — matches how the real staff.route.ts wires this dependency.
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
      emailProvider,
      staffScheduleRepository,
      staffTimeOffRepository,
      staffAvatarService,
    );
    tokenService = new TokenService(new SessionRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const createBusinessOwner = async (email: string, businessName: string) => {
    const user = await userRepository.create({
      normalizedEmail: email,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const business = await businessRepository.create(businessInput(user._id, businessName));
    return { user, business };
  };

  /**
   * Builds a minimal Express app mirroring api-router.ts's real mounting order: the
   * Owner-or-Supervisor(-or-Staff) schedule/time-off/list router is registered FIRST with its
   * own per-route auth (no blanket gate), then the Owner-only core-identity router is
   * registered behind a blanket Owner-only gate — same order/rationale as
   * createStaffScheduleRoute() being mounted before createBusinessRoute() in production.
   */
  const buildStaffApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/businesses", createStaffScheduleRoute());
    app.use(
      createAuthenticateAccessTokenMiddleware(tokenService, userRepository),
      requireActiveUser(),
      requireRoles(["BUSINESS_OWNER"]),
    );
    app.use("/businesses", createStaffRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF",
  ) => `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  /** Narrows a StaffMemberDto's membershipId (null only for the synthesized owner row). */
  const requireMembershipId = (member: { membershipId: string | null }): string => {
    if (!member.membershipId) {
      throw new Error("Expected a real Staff membership id, got the synthesized owner row");
    }

    return member.membershipId;
  };

  // --- Index invariants -----------------------------------------------------------

  it("enforces one active Staff membership per userId at the database level (partial unique index)", async () => {
    const indexes = await indexesFor(StaffMembershipModel);
    const userIdIndex = indexes.find(
      (index) => index.key["userId"] === 1 && Object.keys(index.key).length === 1,
    );
    expect(userIdIndex?.unique).toBe(true);
    expect(userIdIndex?.partialFilterExpression).toEqual({ removedAt: { $eq: null } });
  });

  it("findActiveByUserId uses the partial {userId} index (query shape matches the partial filter), not a collection scan", async () => {
    const { user: owner, business } = await createBusinessOwner(
      "owner-a@example.com",
      "Business A",
    );
    const created = await seedStaffMember(
      userRepository,
      staffRepository,
      owner._id,
      business._id,
      {
        name: "Vivi M",
        email: "vivi@example.com",
        role: "SUPERVISOR",
      },
    );

    const explanation = (await StaffMembershipModel.findOne({
      userId: created.userId,
      removedAt: null,
    })
      .explain("executionStats")
      .then((result) => result)) as {
      executionStats?: { executionStages?: { stage?: string; inputStage?: { stage?: string } } };
    };

    const stages = [
      explanation.executionStats?.executionStages?.stage,
      explanation.executionStats?.executionStages?.inputStage?.stage,
    ];
    expect(stages).not.toContain("COLLSCAN");
    expect(stages.some((stage) => stage === "IXSCAN" || stage === "FETCH")).toBe(true);

    // The repository's fixed query and the old `{$exists: false}` shape return the identical
    // row — proving this was purely a query-plan improvement, never a behavior change.
    const viaRepository = await staffRepository.findActiveByUserId(created.userId);
    const viaOldExistsShape = await StaffMembershipModel.findOne({
      userId: created.userId,
      removedAt: { $exists: false },
    }).exec();
    expect(String(viaRepository?._id)).toBe(String(created.membershipId));
    expect(String(viaOldExistsShape?._id)).toBe(String(created.membershipId));
  });

  // --- Creation: owned-Business-only authorization ------------------------

  it("issues a PENDING invitation (no User, no StaffMembership) for SUPERVISOR and STAFF, and emails a link", async () => {
    const { user: owner, business } = await createBusinessOwner(
      "owner-a@example.com",
      "Business A",
    );

    const supervisor = await staffService.createStaff(String(owner._id), String(business._id), {
      name: "Vivi M",
      email: "vivi@example.com",
      role: "SUPERVISOR",
    });
    const staff = await staffService.createStaff(String(owner._id), String(business._id), {
      name: "Rania A",
      email: "rania@example.com",
      role: "STAFF",
    });

    expect(supervisor).toMatchObject({ role: "SUPERVISOR", status: "PENDING" });
    expect(staff).toMatchObject({ role: "STAFF", status: "PENDING" });
    expect(supervisor.invitationId).toMatch(/^[a-f\d]{24}$/);

    // Option B — nothing is provisioned until the invitee accepts.
    expect(await UserModel.countDocuments({})).toBe(1); // just the owner
    expect(await StaffMembershipModel.countDocuments({ businessId: business._id })).toBe(0);
    expect(
      await StaffInvitationModel.countDocuments({ businessId: business._id, status: "PENDING" }),
    ).toBe(2);

    // The invitation link email — never a password / code.
    expect(emailProvider.noticeCount).toBe(2);
    expect(emailProvider.lastNoticeTo).toBe("rania@example.com");
    expect(emailProvider.lastNoticeText).toContain("/staff/invite/accept?token=");
  });

  it("denies staff creation for a Business the actor only has a BusinessAccess link to — the original owner can still manage it", async () => {
    const { user: ownerA } = await createBusinessOwner("owner-a@example.com", "Business A");
    const { user: ownerB, business: businessB } = await createBusinessOwner(
      "owner-b@example.com",
      "Business B",
    );
    await businessAccessRepository.create({ userId: ownerA._id, businessId: businessB._id });

    // BusinessAccess (linked Business) grants no Staff-management rights — the Staff domain
    // recognizes ownership only.
    await expect(
      staffService.createStaff(String(ownerA._id), String(businessB._id), {
        name: "Nikos K",
        email: "nikos@example.com",
        role: "STAFF",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await StaffMembershipModel.countDocuments({ businessId: businessB._id })).toBe(0);

    // Business B's real owner is unaffected and can still create/manage its Staff normally.
    const created = await seedStaffMember(
      userRepository,
      staffRepository,
      ownerB._id,
      businessB._id,
      {
        name: "Nikos K",
        email: "nikos@example.com",
        role: "STAFF",
      },
    );
    const listForOwnerB = await staffService.listStaff(String(ownerB._id), String(businessB._id));
    expect(listForOwnerB.members.some((member) => member.email === "nikos@example.com")).toBe(true);
    expect(created.businessId).toBe(String(businessB._id));
  });

  it("rejects staff creation for an unrelated Business and for a since-unlinked Business", async () => {
    const { user: ownerA } = await createBusinessOwner("owner-a@example.com", "Business A");
    const { business: businessB } = await createBusinessOwner("owner-b@example.com", "Business B");

    await expect(
      staffService.createStaff(String(ownerA._id), String(businessB._id), {
        name: "Nobody",
        email: "nobody@example.com",
        role: "STAFF",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    await businessAccessRepository.create({ userId: ownerA._id, businessId: businessB._id });
    await businessAccessRepository.deleteByUserAndBusiness(ownerA._id, businessB._id);

    await expect(
      staffService.createStaff(String(ownerA._id), String(businessB._id), {
        name: "Still Nobody",
        email: "still-nobody@example.com",
        role: "STAFF",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await StaffMembershipModel.countDocuments()).toBe(0);
  });

  // --- Role-escalation rejection at the real HTTP boundary -------------------------

  it("rejects role=BUSINESS_OWNER / SUPER_ADMIN / CUSTOMER at the real API boundary, and ignores mass-assigned fields", async () => {
    const { user: owner, business } = await createBusinessOwner(
      "owner-a@example.com",
      "Business A",
    );
    const app = buildStaffApp();
    const token = await bearerFor(owner._id, "BUSINESS_OWNER");

    for (const role of ["BUSINESS_OWNER", "SUPER_ADMIN", "CUSTOMER", "ADMIN"]) {
      const response = await request(app)
        .post(`/businesses/${business._id}/staff`)
        .set("Authorization", token)
        .send({ name: "Attacker", email: `attacker-${role}@example.com`, role });
      expect(response.status).toBe(400);
    }

    // Strict schema: unknown/injected fields are rejected outright rather than silently dropped.
    const injected = await request(app)
      .post(`/businesses/${business._id}/staff`)
      .set("Authorization", token)
      .send({
        name: "Injector",
        email: "injector@example.com",
        role: "STAFF",
        userId: "000000000000000000000000",
        createdByUserId: "000000000000000000000000",
        ownerUserId: "000000000000000000000000",
        status: "SUSPENDED",
        employmentActive: false,
        schedule: {},
        services: [],
        permissions: ["ALL"],
      });
    expect(injected.status).toBe(400);
    expect(await StaffMembershipModel.countDocuments()).toBe(0);
  });

  it("rejects a SUPERVISOR or STAFF token from creating/removing staff (BUSINESS_OWNER-only in Phase 1)", async () => {
    const { user: owner, business } = await createBusinessOwner(
      "owner-a@example.com",
      "Business A",
    );
    const supervisor = await seedStaffMember(
      userRepository,
      staffRepository,
      owner._id,
      business._id,
      {
        name: "Vivi M",
        email: "vivi@example.com",
        role: "SUPERVISOR",
      },
    );

    const app = buildStaffApp();
    const supervisorToken = await bearerFor(supervisor.userId, "SUPERVISOR");

    const response = await request(app)
      .post(`/businesses/${business._id}/staff`)
      .set("Authorization", supervisorToken)
      .send({ name: "New Hire", email: "new-hire@example.com", role: "STAFF" });
    expect(response.status).toBe(403);
  });

  // --- Email global-uniqueness ------------------------------------------------------

  it("rejects an existing CUSTOMER/owner email and any duplicate email, without creating a duplicate user", async () => {
    const { user: owner, business } = await createBusinessOwner(
      "owner-a@example.com",
      "Business A",
    );
    await userRepository.create({
      normalizedEmail: "customer@example.com",
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });

    await expect(
      staffService.createStaff(String(owner._id), String(business._id), {
        name: "Reused",
        email: "customer@example.com",
        role: "STAFF",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    await expect(
      staffService.createStaff(String(owner._id), String(business._id), {
        name: "Reused Owner",
        email: "owner-a@example.com",
        role: "STAFF",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await UserModel.countDocuments({ role: { $in: ["SUPERVISOR", "STAFF"] } })).toBe(0);
  });

  it("keeps a removed staff member's email reserved (cannot be reused to create a new account)", async () => {
    const { user: owner, business } = await createBusinessOwner(
      "owner-a@example.com",
      "Business A",
    );
    const created = await seedStaffMember(
      userRepository,
      staffRepository,
      owner._id,
      business._id,
      {
        name: "Gone Soon",
        email: "gone@example.com",
        role: "STAFF",
      },
    );

    await staffService.removeStaff(
      String(owner._id),
      String(business._id),
      requireMembershipId(created),
    );

    await expect(
      staffService.createStaff(String(owner._id), String(business._id), {
        name: "Reincarnated",
        email: "gone@example.com",
        role: "STAFF",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await UserModel.countDocuments({ normalizedEmail: "gone@example.com" })).toBe(1);
  });

  // --- Role update allowlist ---------------------------------------------------------

  it("allows SUPERVISOR <-> STAFF role updates but rejects escalation to BUSINESS_OWNER/SUPER_ADMIN", async () => {
    const { user: owner, business } = await createBusinessOwner(
      "owner-a@example.com",
      "Business A",
    );
    const created = await seedStaffMember(
      userRepository,
      staffRepository,
      owner._id,
      business._id,
      {
        name: "Vivi M",
        email: "vivi@example.com",
        role: "STAFF",
      },
    );

    const promoted = await staffService.updateStaff(
      String(owner._id),
      String(business._id),
      requireMembershipId(created),
      { role: "SUPERVISOR" },
    );
    expect(promoted.role).toBe("SUPERVISOR");
    expect((await UserModel.findById(created.userId).orFail()).role).toBe("SUPERVISOR");

    const app = buildStaffApp();
    const token = await bearerFor(owner._id, "BUSINESS_OWNER");
    for (const role of ["BUSINESS_OWNER", "SUPER_ADMIN"]) {
      const response = await request(app)
        .patch(`/businesses/${business._id}/staff/${created.membershipId}`)
        .set("Authorization", token)
        .send({ role });
      expect(response.status).toBe(400);
    }
    expect((await UserModel.findById(created.userId).orFail()).role).toBe("SUPERVISOR");
  });

  it("rolls back StaffMembership.role if the paired User.role write fails mid-transaction — no split-brain", async () => {
    const { user: owner, business } = await createBusinessOwner(
      "owner-a@example.com",
      "Business A",
    );
    const created = await seedStaffMember(
      userRepository,
      staffRepository,
      owner._id,
      business._id,
      {
        name: "Rollback Test",
        email: "rollback@example.com",
        role: "STAFF",
      },
    );

    const updateRoleSpy = vi
      .spyOn(userRepository, "updateRole")
      .mockRejectedValueOnce(new Error("simulated mid-transaction failure"));

    await expect(
      staffService.updateStaff(
        String(owner._id),
        String(business._id),
        requireMembershipId(created),
        { role: "SUPERVISOR" },
      ),
    ).rejects.toThrow("simulated mid-transaction failure");

    // Neither write took effect — StaffMembership.role must not have moved without User.role
    // moving with it (the exact split-brain this transaction exists to prevent).
    expect((await StaffMembershipModel.findById(created.membershipId).orFail()).role).toBe("STAFF");
    expect((await UserModel.findById(created.userId).orFail()).role).toBe("STAFF");

    updateRoleSpy.mockRestore();
  });

  // --- One-Business-per-Staff invariant ----------------------------------------------

  it("cannot attach the same Staff identity to a second Business", async () => {
    const { user: owner, business: businessA } = await createBusinessOwner(
      "owner-a@example.com",
      "Business A",
    );
    const { business: businessB } = await createBusinessOwner("owner-b@example.com", "Business B");

    const created = await seedStaffMember(
      userRepository,
      staffRepository,
      owner._id,
      businessA._id,
      {
        name: "One Business Only",
        email: "one-business@example.com",
        role: "STAFF",
      },
    );

    // Directly attempting a second active membership for the same userId at the repository
    // level must fail the partial-unique index — this is the DB-level backstop, independent
    // of the fact the email-uniqueness check would already prevent this via the service.
    await expect(
      staffRepository.create({
        userId: new mongoose.Types.ObjectId(created.userId),
        businessId: businessB._id,
        role: "STAFF",
        createdByUserId: owner._id,
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  // --- employmentActive vs. User.status separation -----------------------------------

  it("toggling employmentActive never touches User.status, and soft-removal preserves User/UserProfile", async () => {
    const { user: owner, business } = await createBusinessOwner(
      "owner-a@example.com",
      "Business A",
    );
    const created = await seedStaffMember(
      userRepository,
      staffRepository,
      owner._id,
      business._id,
      {
        name: "Rania A",
        email: "rania@example.com",
        role: "STAFF",
      },
    );

    const deactivated = await staffService.updateStaff(
      String(owner._id),
      String(business._id),
      requireMembershipId(created),
      { employmentActive: false },
    );
    expect(deactivated.employmentActive).toBe(false);
    const userAfterToggle = await UserModel.findById(created.userId).orFail();
    expect(userAfterToggle.status).toBe("ACTIVE");

    await staffService.removeStaff(
      String(owner._id),
      String(business._id),
      requireMembershipId(created),
    );

    // Disappears from the active list...
    const list = await staffService.listStaff(String(owner._id), String(business._id));
    expect(list.members.some((member) => member.membershipId === created.membershipId)).toBe(false);

    // ...but User and UserProfile survive untouched, and the login account is not suspended.
    const survivingUser = await UserModel.findById(created.userId).orFail();
    expect(survivingUser.status).toBe("ACTIVE");
    const survivingProfile = await UserProfileModel.findOne({ userId: created.userId }).orFail();
    expect(survivingProfile.firstName).toBeTruthy();

    const membershipDoc = await StaffMembershipModel.findById(created.membershipId).orFail();
    expect(membershipDoc.removedAt).toBeInstanceOf(Date);
    expect(membershipDoc.employmentActive).toBe(false);
  });

  // --- Owner row: synthesized, not editable/removable as Staff -----------------------

  it("synthesizes the owner row in the staff list and refuses to edit/remove it as a Staff record", async () => {
    const { user: owner, business } = await createBusinessOwner(
      "owner-a@example.com",
      "Business A",
    );
    await userRepository.createProfile({
      userId: owner._id,
      firstName: "Elena",
      lastName: "G",
      gender: "other",
    });

    const list = await staffService.listStaff(String(owner._id), String(business._id));
    const ownerRow = list.members.find((member) => member.isOwner);
    expect(ownerRow).toBeTruthy();
    expect(ownerRow?.membershipId).toBeNull();
    expect(ownerRow?.role).toBe("BUSINESS_OWNER");
    expect(await StaffMembershipModel.countDocuments({ userId: owner._id })).toBe(0);

    // No StaffMembership id exists for the owner, so any staffId targeting them 404s.
    await expect(
      staffService.updateStaff(String(owner._id), String(business._id), String(owner._id), {
        employmentActive: false,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      staffService.removeStaff(String(owner._id), String(business._id), String(owner._id)),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  // --- Bounded query count -------------------------------------------------------------

  it("lists staff with a bounded, non-N+1 query shape regardless of staff count", async () => {
    const { user: owner, business } = await createBusinessOwner(
      "owner-a@example.com",
      "Business A",
    );
    for (let index = 0; index < 5; index += 1) {
      await seedStaffMember(userRepository, staffRepository, owner._id, business._id, {
        name: `Staff ${index}`,
        email: `staff${index}@example.com`,
        role: "STAFF",
      });
    }

    const list = await staffService.listStaff(String(owner._id), String(business._id));
    expect(list.members).toHaveLength(6); // owner + 5 staff
  });

  // --- Staff-domain authorization does not broaden unrelated domains -----------------

  it("matches BusinessMedia's owner-only authorization for a linked-only actor — Staff no longer broadens it", async () => {
    const { user: ownerA } = await createBusinessOwner("owner-a@example.com", "Business A");
    const { business: businessB } = await createBusinessOwner("owner-b@example.com", "Business B");
    await businessAccessRepository.create({ userId: ownerA._id, businessId: businessB._id });

    // Owner A has a BusinessAccess link to Business B but does not own it — Staff denies...
    await expect(
      staffService.createStaff(String(ownerA._id), String(businessB._id), {
        name: "Linked Staff",
        email: "linked-staff@example.com",
        role: "STAFF",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    // ...exactly as BusinessMedia (a different domain, untouched by this phase) already did —
    // both now recognize ownership only, never BusinessAccess, for mutating operations.
    const businessMediaService = new BusinessMediaService(
      new BusinessMediaRepository(),
      businessRepository,
      businessAccessRepository,
      {
        bucket: "test",
        ensureBucket: async () => {},
        putObject: async () => {},
        deleteObject: async () => {},
        getObjectUrl: async () => "https://example.com/x",
        objectExists: async () => false,
      },
      { maxUploadBytes: 1_000_000 },
    );

    await expect(
      businessMediaService.uploadBusinessMedia(String(ownerA._id), String(businessB._id), {
        buffer: Buffer.from("x"),
        mimeType: "image/png",
        size: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  // --- Invitation issuance (Phase 2D) ---------------------------------------------------

  it("createStaff issues a PENDING invitation, stores only a token hash, and creates no User/membership", async () => {
    const { user: owner, business } = await createBusinessOwner(
      "owner-a@example.com",
      "Business A",
    );

    const created = await staffService.createStaff(String(owner._id), String(business._id), {
      name: "Fresh Hire",
      email: "fresh-hire@example.com",
      role: "STAFF",
    });

    expect(created).not.toHaveProperty("password");
    expect(created).not.toHaveProperty("userId");
    expect(created).not.toHaveProperty("membershipId");
    expect(JSON.stringify(created)).not.toContain("token");

    const invitation = await StaffInvitationModel.findById(created.invitationId)
      .select("+tokenHash")
      .orFail();
    expect(invitation.status).toBe("PENDING");
    expect(invitation.tokenHash).toMatch(/^[a-f\d]{64}$/); // sha256 hex, never the raw token

    expect(await UserModel.countDocuments({ normalizedEmail: "fresh-hire@example.com" })).toBe(0);
    expect(await StaffMembershipModel.countDocuments()).toBe(0);

    // The emailed link carries the RAW token (which is never persisted).
    const linkMatch = emailProvider.lastNoticeText.match(/accept\?token=([^\s]+)/);
    expect(linkMatch).not.toBeNull();
  });

  it("a STAFF who accepted their invitation with a password logs in through the existing professional login", async () => {
    const { user: owner, business } = await createBusinessOwner(
      "owner-a@example.com",
      "Business A",
    );

    const invitationRepository = new StaffInvitationRepository();
    const invitationService = new StaffInvitationService(invitationRepository, userRepository);
    const acceptService = new StaffInvitationAcceptService(
      invitationService,
      invitationRepository,
      userRepository,
      staffRepository,
      new LinkedAccountRepository(),
      new Argon2PasswordHasher(),
      new TokenService(new SessionRepository()),
    );

    const { token } = await invitationService.issue({
      businessId: business._id,
      invitedByUserId: owner._id,
      email: "fresh-hire@example.com",
      role: "STAFF",
    });

    await acceptService.acceptWithPassword(
      {
        token,
        password: "s3cret-pass",
        firstName: "Fresh",
        lastName: "Hire",
        agreeTerms: true,
      },
      { userAgent: "vitest", ipAddress: "127.0.0.1" },
    );

    const registrationSessionRepository = new RegistrationSessionRepository();
    const businessOnboardingRepository = new BusinessOnboardingRepository();
    const businessOnboardingService = new BusinessOnboardingService(businessOnboardingRepository);
    const businessService = new BusinessService(
      businessRepository,
      businessAccessRepository,
      userRepository,
      new BusinessLinkVerificationRepository(),
      emailProvider,
    );
    const authService = new AuthService(
      userRepository,
      registrationSessionRepository,
      businessOnboardingRepository,
      businessOnboardingService,
      businessRepository,
      new Argon2PasswordHasher(),
      emailProvider,
      { sendOtp: async () => ({}), verifyOtp: async () => false },
      new TokenService(new SessionRepository()),
      businessService,
      new StaffRepository(),
      new ClientIdentityService(userRepository, new ClientRepository()),
      new ContactChangeChallengeRepository(),
    );

    const result = await authService.login(
      "PROFESSIONAL",
      { email: "fresh-hire@example.com", password: "s3cret-pass" },
      { userAgent: "vitest", ipAddress: "127.0.0.1" },
    );

    expect(result.user.role).toBe("STAFF");
    expect(result.accessToken).toEqual(expect.any(String));
    expect(await StaffMembershipModel.countDocuments({ businessId: business._id })).toBe(1);
  });

  it("surfaces STAFF_INVITATION_EMAIL_FAILED when the link email cannot be sent (the invitation still exists)", async () => {
    const { user: owner, business } = await createBusinessOwner(
      "owner-a@example.com",
      "Business A",
    );
    emailProvider.shouldFail = true;

    await expect(
      staffService.createStaff(String(owner._id), String(business._id), {
        name: "Email Fails",
        email: "email-fails@example.com",
        role: "STAFF",
      }),
    ).rejects.toMatchObject({ statusCode: 502 });

    // No User (Option B) — but the invitation row persisted, so the owner can "resend".
    expect(await UserModel.countDocuments({ normalizedEmail: "email-fails@example.com" })).toBe(0);
    expect(await StaffMembershipModel.countDocuments()).toBe(0);
    expect(
      await StaffInvitationModel.countDocuments({
        email: "email-fails@example.com",
        status: "PENDING",
      }),
    ).toBe(1);
  });

  // ================================================================================
  // Phase 2: business switcher, Supervisor toggle, schedule, time off
  // ================================================================================

  describe("Phase 2 — owned-Business-only Staff access (business switcher removed)", () => {
    it("Primary Business Staff list works normally; a linked (not owned) Business is fully denied, same as an unrelated one", async () => {
      const { user: owner, business: primary } = await createBusinessOwner(
        "owner-a@example.com",
        "Primary Business",
      );
      const { business: linkedA } = await createBusinessOwner("owner-b@example.com", "Linked A");
      const { business: unrelated } = await createBusinessOwner("owner-c@example.com", "Unrelated");
      await businessAccessRepository.create({ userId: owner._id, businessId: linkedA._id });

      await seedStaffMember(userRepository, staffRepository, owner._id, primary._id, {
        name: "Primary Staff",
        email: "primary-staff@example.com",
        role: "STAFF",
      });

      const primaryList = await staffService.listStaff(String(owner._id), String(primary._id));
      expect(primaryList.members.some((m) => m.email === "primary-staff@example.com")).toBe(true);

      // The BusinessAccess link to Linked A grants no Staff-management rights at all —
      // listing and creating are both denied, identically to a wholly unrelated Business.
      await expect(
        staffService.listStaff(String(owner._id), String(linkedA._id)),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        staffService.createStaff(String(owner._id), String(linkedA._id), {
          name: "Linked Staff",
          email: "linked-staff@example.com",
          role: "STAFF",
        }),
      ).rejects.toMatchObject({ statusCode: 404 });

      await expect(
        staffService.listStaff(String(owner._id), String(unrelated._id)),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("rejects a forged unrelated businessId at the real HTTP boundary — 404, indistinguishable from a nonexistent business", async () => {
      const { user: owner } = await createBusinessOwner("owner-a@example.com", "Primary Business");
      const { business: unrelated } = await createBusinessOwner("owner-c@example.com", "Unrelated");
      const app = buildStaffApp();
      const token = await bearerFor(owner._id, "BUSINESS_OWNER");

      const response = await request(app)
        .get(`/businesses/${unrelated._id}/staff`)
        .set("Authorization", token);
      expect(response.status).toBe(404);

      const nonexistentResponse = await request(app)
        .get(`/businesses/000000000000000000000000/staff`)
        .set("Authorization", token);
      expect(nonexistentResponse.status).toBe(404);
      expect(nonexistentResponse.body).toEqual(response.body);
    });
  });

  describe("Phase 2 — Supervisor Active/Inactive", () => {
    it("toggles employmentActive for a SUPERVISOR without touching User.status or login", async () => {
      const { user: owner, business } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      const created = await seedStaffMember(
        userRepository,
        staffRepository,
        owner._id,
        business._id,
        {
          name: "Sup Ervisor",
          email: "supervisor@example.com",
          role: "SUPERVISOR",
        },
      );

      const updated = await staffService.updateStaff(
        String(owner._id),
        String(business._id),
        requireMembershipId(created),
        { employmentActive: false },
      );

      expect(updated.employmentActive).toBe(false);
      expect(updated.role).toBe("SUPERVISOR");
      const user = await UserModel.findById(created.userId).orFail();
      expect(user.status).toBe("ACTIVE");
    });
  });

  describe("Phase 4A — Supervisor schedule/list access + Staff self-service (real HTTP boundary)", () => {
    it("allows an active SUPERVISOR to list staff and read/write a colleague's schedule", async () => {
      const { user: owner, business } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      const supervisor = await seedStaffMember(
        userRepository,
        staffRepository,
        owner._id,
        business._id,
        { name: "Sup Ervisor", email: "supervisor@example.com", role: "SUPERVISOR" },
      );
      const staff = await seedStaffMember(
        userRepository,
        staffRepository,
        owner._id,
        business._id,
        { name: "Staff A", email: "staff-a@example.com", role: "STAFF" },
      );

      const app = buildStaffApp();
      const supervisorToken = await bearerFor(supervisor.userId, "SUPERVISOR");

      const listResponse = await request(app)
        .get(`/businesses/${business._id}/staff`)
        .set("Authorization", supervisorToken);
      expect(listResponse.status).toBe(200);
      expect(
        listResponse.body.data.members.some(
          (m: { email: string }) => m.email === "staff-a@example.com",
        ),
      ).toBe(true);

      const putResponse = await request(app)
        .put(`/businesses/${business._id}/staff/${requireMembershipId(staff)}/schedule`)
        .set("Authorization", supervisorToken)
        .send({ days: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" }] });
      expect(putResponse.status).toBe(200);

      const getResponse = await request(app)
        .get(`/businesses/${business._id}/staff/${requireMembershipId(staff)}/schedule`)
        .set("Authorization", supervisorToken);
      expect(getResponse.status).toBe(200);
      expect(getResponse.body.data).toEqual([
        { dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" },
      ]);
    });

    it("rejects a plain STAFF token from the list/schedule endpoints (Owner-or-Supervisor only)", async () => {
      const { user: owner, business } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      const staff = await seedStaffMember(
        userRepository,
        staffRepository,
        owner._id,
        business._id,
        { name: "Staff A", email: "staff-a@example.com", role: "STAFF" },
      );
      const app = buildStaffApp();
      const staffToken = await bearerFor(staff.userId, "STAFF");

      const listResponse = await request(app)
        .get(`/businesses/${business._id}/staff`)
        .set("Authorization", staffToken);
      expect(listResponse.status).toBe(403);

      const scheduleResponse = await request(app)
        .get(`/businesses/${business._id}/staff/${requireMembershipId(staff)}/schedule`)
        .set("Authorization", staffToken);
      expect(scheduleResponse.status).toBe(403);
    });

    it("rejects a SUPERVISOR of a DIFFERENT business — 404, indistinguishable from a nonexistent business", async () => {
      const { business: businessA } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      const { user: ownerB, business: businessB } = await createBusinessOwner(
        "owner-b@example.com",
        "Business B",
      );
      const supervisorB = await seedStaffMember(
        userRepository,
        staffRepository,
        ownerB._id,
        businessB._id,
        { name: "Sup B", email: "sup-b@example.com", role: "SUPERVISOR" },
      );
      const app = buildStaffApp();
      const supervisorBToken = await bearerFor(supervisorB.userId, "SUPERVISOR");

      const response = await request(app)
        .get(`/businesses/${businessA._id}/staff`)
        .set("Authorization", supervisorBToken);
      expect(response.status).toBe(404);
    });

    it("lets STAFF and SUPERVISOR read their OWN schedule via /staff/me/schedule, but not each other's or the Owner's", async () => {
      const { user: owner, business } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      const staff = await seedStaffMember(
        userRepository,
        staffRepository,
        owner._id,
        business._id,
        { name: "Staff A", email: "staff-a@example.com", role: "STAFF" },
      );
      await staffService.putSchedule(
        String(owner._id),
        String(business._id),
        requireMembershipId(staff),
        {
          days: [{ dayOfWeek: "TUESDAY", startTime: "10:00", endTime: "18:00" }],
        },
      );

      const app = buildStaffApp();
      const staffToken = await bearerFor(staff.userId, "STAFF");

      const myScheduleResponse = await request(app)
        .get(`/businesses/${business._id}/staff/me/schedule`)
        .set("Authorization", staffToken);
      expect(myScheduleResponse.status).toBe(200);
      expect(myScheduleResponse.body.data).toEqual([
        { dayOfWeek: "TUESDAY", startTime: "10:00", endTime: "18:00" },
      ]);

      // The Owner has no StaffMembership row at all — /me/schedule 404s rather than
      // synthesizing an empty schedule for them.
      const ownerToken = await bearerFor(owner._id, "BUSINESS_OWNER");
      const ownerMyScheduleResponse = await request(app)
        .get(`/businesses/${business._id}/staff/me/schedule`)
        .set("Authorization", ownerToken);
      expect(ownerMyScheduleResponse.status).toBe(404);
    });

    it("lets STAFF read their own assigned services via /staff/me/services", async () => {
      const { user: owner, business } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      const staff = await seedStaffMember(
        userRepository,
        staffRepository,
        owner._id,
        business._id,
        { name: "Staff A", email: "staff-a@example.com", role: "STAFF" },
      );

      const app = buildStaffApp();
      const staffToken = await bearerFor(staff.userId, "STAFF");

      const response = await request(app)
        .get(`/businesses/${business._id}/staff/me/services`)
        .set("Authorization", staffToken);
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
    });
  });

  describe("Phase 2 — Staff schedule", () => {
    it("enforces a unique schedule document per membership", async () => {
      const indexes = (await StaffScheduleModel.collection.indexes()) as Array<{
        key: Record<string, unknown>;
        unique?: boolean;
      }>;
      expect(
        indexes.some((index) => index.key["membershipId"] === 1 && index.unique === true),
      ).toBe(true);
    });

    it("persists a different start/end per weekday, survives reload, and each staff member is isolated", async () => {
      const { user: owner, business } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      const staffA = await seedStaffMember(
        userRepository,
        staffRepository,
        owner._id,
        business._id,
        {
          name: "Staff A",
          email: "staff-a@example.com",
          role: "STAFF",
        },
      );
      const staffB = await seedStaffMember(
        userRepository,
        staffRepository,
        owner._id,
        business._id,
        {
          name: "Staff B",
          email: "staff-b@example.com",
          role: "STAFF",
        },
      );

      await staffService.putSchedule(
        String(owner._id),
        String(business._id),
        requireMembershipId(staffA),
        {
          days: [
            { dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" },
            { dayOfWeek: "TUESDAY", startTime: "10:00", endTime: "18:00" },
            { dayOfWeek: "WEDNESDAY", startTime: "08:30", endTime: "16:00" },
          ],
        },
      );

      const reloaded = await staffService.getSchedule(
        String(owner._id),
        String(business._id),
        requireMembershipId(staffA),
      );
      expect(reloaded).toEqual([
        { dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" },
        { dayOfWeek: "TUESDAY", startTime: "10:00", endTime: "18:00" },
        { dayOfWeek: "WEDNESDAY", startTime: "08:30", endTime: "16:00" },
      ]);

      // Staff B's schedule is untouched by Staff A's.
      const staffBSchedule = await staffService.getSchedule(
        String(owner._id),
        String(business._id),
        requireMembershipId(staffB),
      );
      expect(staffBSchedule).toEqual([]);
    });

    it("replacing the schedule enforces at most one shift per day (last entry wins on duplicate)", async () => {
      const { user: owner, business } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      const staff = await seedStaffMember(
        userRepository,
        staffRepository,
        owner._id,
        business._id,
        {
          name: "Staff A",
          email: "staff-a@example.com",
          role: "STAFF",
        },
      );

      // Bypasses the schema's duplicate-day rejection to prove the service itself also
      // never persists two shifts for the same day (defense in depth).
      const result = await staffService.putSchedule(
        String(owner._id),
        String(business._id),
        requireMembershipId(staff),
        {
          days: [
            { dayOfWeek: "MONDAY", startTime: "09:00", endTime: "13:00" },
            { dayOfWeek: "MONDAY", startTime: "15:00", endTime: "19:00" },
          ],
        },
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ dayOfWeek: "MONDAY", startTime: "15:00", endTime: "19:00" });

      const doc = await StaffScheduleModel.findOne({ membershipId: staff.membershipId }).orFail();
      expect(doc.days).toHaveLength(1);
    });

    it("PUT replacing an empty schedule clears all days (day off for every day)", async () => {
      const { user: owner, business } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      const staff = await seedStaffMember(
        userRepository,
        staffRepository,
        owner._id,
        business._id,
        {
          name: "Staff A",
          email: "staff-a@example.com",
          role: "STAFF",
        },
      );

      await staffService.putSchedule(
        String(owner._id),
        String(business._id),
        requireMembershipId(staff),
        {
          days: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" }],
        },
      );
      const cleared = await staffService.putSchedule(
        String(owner._id),
        String(business._id),
        requireMembershipId(staff),
        { days: [] },
      );

      expect(cleared).toEqual([]);
    });

    it("rejects malformed time and start>=end at the real HTTP boundary", async () => {
      const { user: owner, business } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      const staff = await seedStaffMember(
        userRepository,
        staffRepository,
        owner._id,
        business._id,
        {
          name: "Staff A",
          email: "staff-a@example.com",
          role: "STAFF",
        },
      );
      const app = buildStaffApp();
      const token = await bearerFor(owner._id, "BUSINESS_OWNER");

      const malformed = await request(app)
        .put(`/businesses/${business._id}/staff/${staff.membershipId}/schedule`)
        .set("Authorization", token)
        .send({ days: [{ dayOfWeek: "MONDAY", startTime: "9:00 AM", endTime: "17:00" }] });
      expect(malformed.status).toBe(400);

      const reversed = await request(app)
        .put(`/businesses/${business._id}/staff/${staff.membershipId}/schedule`)
        .set("Authorization", token)
        .send({ days: [{ dayOfWeek: "MONDAY", startTime: "17:00", endTime: "09:00" }] });
      expect(reversed.status).toBe(400);

      expect(await StaffScheduleModel.countDocuments()).toBe(0);
    });

    it("cannot create a schedule for the synthesized Owner row (no StaffMembership exists for it)", async () => {
      const { user: owner, business } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );

      await expect(
        staffService.putSchedule(String(owner._id), String(business._id), String(owner._id), {
          days: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" }],
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(await StaffScheduleModel.countDocuments()).toBe(0);
    });

    it("removed Staff cannot receive new schedule edits, and a linked (not owned) Business's schedule is denied outright", async () => {
      const { user: ownerA, business: businessA } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      const { user: ownerB, business: businessB } = await createBusinessOwner(
        "owner-b@example.com",
        "Business B",
      );
      await businessAccessRepository.create({ userId: ownerA._id, businessId: businessB._id });

      const removedStaff = await seedStaffMember(
        userRepository,
        staffRepository,
        ownerA._id,
        businessA._id,
        { name: "Gone", email: "gone-schedule@example.com", role: "STAFF" },
      );
      await staffService.removeStaff(
        String(ownerA._id),
        String(businessA._id),
        requireMembershipId(removedStaff),
      );

      await expect(
        staffService.putSchedule(
          String(ownerA._id),
          String(businessA._id),
          requireMembershipId(removedStaff),
          { days: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" }] },
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      // ownerA's BusinessAccess link to Business B grants no schedule-management rights —
      // its real owner (ownerB) still can.
      const linkedStaff = await seedStaffMember(
        userRepository,
        staffRepository,
        ownerB._id,
        businessB._id,
        { name: "B's Staffer", email: "b-schedule@example.com", role: "STAFF" },
      );
      await expect(
        staffService.putSchedule(
          String(ownerA._id),
          String(businessB._id),
          requireMembershipId(linkedStaff),
          { days: [{ dayOfWeek: "FRIDAY", startTime: "12:00", endTime: "20:00" }] },
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      const schedule = await staffService.putSchedule(
        String(ownerB._id),
        String(businessB._id),
        requireMembershipId(linkedStaff),
        { days: [{ dayOfWeek: "FRIDAY", startTime: "12:00", endTime: "20:00" }] },
      );
      expect(schedule).toEqual([{ dayOfWeek: "FRIDAY", startTime: "12:00", endTime: "20:00" }]);
    });

    it("does not allow mutating a staff member's schedule through a different (non-owning) Business id", async () => {
      const { user: ownerA, business: businessA } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      const { business: businessB } = await createBusinessOwner(
        "owner-b@example.com",
        "Business B",
      );
      const staff = await seedStaffMember(
        userRepository,
        staffRepository,
        ownerA._id,
        businessA._id,
        {
          name: "Staff A",
          email: "cross-business@example.com",
          role: "STAFF",
        },
      );

      await expect(
        staffService.putSchedule(
          String(ownerA._id),
          String(businessB._id),
          requireMembershipId(staff),
          {
            days: [{ dayOfWeek: "MONDAY", startTime: "09:00", endTime: "17:00" }],
          },
        ),
      ).rejects.toMatchObject({ statusCode: 404 }); // ownerA does not manage businessB at all
    });

    it("includes real schedule data (not fake) in the Staff list, and the Owner row has none", async () => {
      const { user: owner, business } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      const staff = await seedStaffMember(
        userRepository,
        staffRepository,
        owner._id,
        business._id,
        {
          name: "Staff A",
          email: "list-schedule@example.com",
          role: "STAFF",
        },
      );
      await staffService.putSchedule(
        String(owner._id),
        String(business._id),
        requireMembershipId(staff),
        {
          days: [{ dayOfWeek: "FRIDAY", startTime: "09:00", endTime: "17:00" }],
        },
      );

      const list = await staffService.listStaff(String(owner._id), String(business._id));
      const ownerRow = list.members.find((m) => m.isOwner);
      const staffRow = list.members.find((m) => m.email === "list-schedule@example.com");

      expect(ownerRow?.schedule).toEqual([]);
      expect(staffRow?.schedule).toEqual([
        { dayOfWeek: "FRIDAY", startTime: "09:00", endTime: "17:00" },
      ]);
    });
  });

  describe("Phase 2 — Staff time off", () => {
    it("supports a single day (startDate === endDate)", async () => {
      const { user: owner, business } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      const staff = await seedStaffMember(
        userRepository,
        staffRepository,
        owner._id,
        business._id,
        {
          name: "Staff A",
          email: "timeoff-single@example.com",
          role: "STAFF",
        },
      );

      const entry = await staffService.createTimeOff(
        String(owner._id),
        String(business._id),
        requireMembershipId(staff),
        { type: "ANNUAL_HOLIDAY", startDate: "2026-06-05" },
      );

      expect(entry.startDate).toBe("2026-06-05");
      expect(entry.endDate).toBe("2026-06-05");
    });

    it("supports an inclusive date range", async () => {
      const { user: owner, business } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      const staff = await seedStaffMember(
        userRepository,
        staffRepository,
        owner._id,
        business._id,
        {
          name: "Staff A",
          email: "timeoff-range@example.com",
          role: "STAFF",
        },
      );

      const entry = await staffService.createTimeOff(
        String(owner._id),
        String(business._id),
        requireMembershipId(staff),
        { type: "SICK_LEAVE", startDate: "2026-06-02", endDate: "2026-06-06" },
      );

      expect(entry.startDate).toBe("2026-06-02");
      expect(entry.endDate).toBe("2026-06-06");

      // Inclusive proof: every calendar day from 2 Jun through 6 Jun is covered.
      const expectedDays = ["2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-06"];
      const isWithinRange = (day: string) => day >= entry.startDate && day <= entry.endDate;
      expect(expectedDays.every(isWithinRange)).toBe(true);
      expect(isWithinRange("2026-06-01")).toBe(false);
      expect(isWithinRange("2026-06-07")).toBe(false);
    });

    it("rejects overlapping time off for the same staff member", async () => {
      const { user: owner, business } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      const staff = await seedStaffMember(
        userRepository,
        staffRepository,
        owner._id,
        business._id,
        {
          name: "Staff A",
          email: "timeoff-overlap@example.com",
          role: "STAFF",
        },
      );

      await staffService.createTimeOff(
        String(owner._id),
        String(business._id),
        requireMembershipId(staff),
        {
          type: "ANNUAL_HOLIDAY",
          startDate: "2026-06-02",
          endDate: "2026-06-06",
        },
      );

      await expect(
        staffService.createTimeOff(
          String(owner._id),
          String(business._id),
          requireMembershipId(staff),
          {
            type: "SICK_LEAVE",
            startDate: "2026-06-05",
            endDate: "2026-06-08",
          },
        ),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(await StaffTimeOffModel.countDocuments()).toBe(1);
    });

    it("rejects a reversed range at the real HTTP boundary", async () => {
      const { user: owner, business } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      const staff = await seedStaffMember(
        userRepository,
        staffRepository,
        owner._id,
        business._id,
        {
          name: "Staff A",
          email: "timeoff-reversed@example.com",
          role: "STAFF",
        },
      );
      const app = buildStaffApp();
      const token = await bearerFor(owner._id, "BUSINESS_OWNER");

      const response = await request(app)
        .post(`/businesses/${business._id}/staff/${staff.membershipId}/time-off`)
        .set("Authorization", token)
        .send({ type: "ANNUAL_HOLIDAY", startDate: "2026-06-06", endDate: "2026-06-02" });
      expect(response.status).toBe(400);
    });

    it("only the correct staff/business owns each entry — isolated across staff, and a linked (not owned) Business is denied", async () => {
      const { user: owner, business } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      const { business: businessB } = await createBusinessOwner(
        "owner-b@example.com",
        "Business B",
      );
      await businessAccessRepository.create({ userId: owner._id, businessId: businessB._id });

      const staffA = await seedStaffMember(
        userRepository,
        staffRepository,
        owner._id,
        business._id,
        {
          name: "Staff A",
          email: "timeoff-a@example.com",
          role: "STAFF",
        },
      );
      const staffB = await seedStaffMember(
        userRepository,
        staffRepository,
        owner._id,
        business._id,
        {
          name: "Staff B",
          email: "timeoff-b@example.com",
          role: "STAFF",
        },
      );

      // owner's BusinessAccess link to Business B grants no Time Off rights — creating Staff
      // there at all is denied.
      await expect(
        staffService.createStaff(String(owner._id), String(businessB._id), {
          name: "Linked Staff",
          email: "timeoff-linked@example.com",
          role: "STAFF",
        }),
      ).rejects.toMatchObject({ statusCode: 404 });

      await staffService.createTimeOff(
        String(owner._id),
        String(business._id),
        requireMembershipId(staffA),
        {
          type: "ANNUAL_HOLIDAY",
          startDate: "2026-06-05",
        },
      );

      expect(
        await staffService.listTimeOff(
          String(owner._id),
          String(business._id),
          requireMembershipId(staffA),
        ),
      ).toHaveLength(1);
      expect(
        await staffService.listTimeOff(
          String(owner._id),
          String(business._id),
          requireMembershipId(staffB),
        ),
      ).toHaveLength(0);
      // listTimeOff against Business B (linked, not owned) is denied outright — there is no
      // Staff row to look up in the first place, since creation was already denied above.
      await expect(
        staffService.listTimeOff(
          String(owner._id),
          String(businessB._id),
          requireMembershipId(staffA),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("Remove wires to a real delete: disappears after removal and does not survive reload", async () => {
      const { user: owner, business } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      const staff = await seedStaffMember(
        userRepository,
        staffRepository,
        owner._id,
        business._id,
        {
          name: "Staff A",
          email: "timeoff-remove@example.com",
          role: "STAFF",
        },
      );
      const entry = await staffService.createTimeOff(
        String(owner._id),
        String(business._id),
        requireMembershipId(staff),
        { type: "ANNUAL_HOLIDAY", startDate: "2026-06-05" },
      );

      await staffService.removeTimeOff(
        String(owner._id),
        String(business._id),
        requireMembershipId(staff),
        entry.id,
      );

      const afterRemoval = await staffService.listTimeOff(
        String(owner._id),
        String(business._id),
        requireMembershipId(staff),
      );
      expect(afterRemoval).toHaveLength(0);

      // Removing does not touch User, StaffMembership, or employmentActive.
      const membership = await StaffMembershipModel.findById(staff.membershipId).orFail();
      expect(membership.employmentActive).toBe(true);
      expect(membership.removedAt).toBeUndefined();
    });

    it("removed Staff cannot receive new Time Off", async () => {
      const { user: owner, business } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      const staff = await seedStaffMember(
        userRepository,
        staffRepository,
        owner._id,
        business._id,
        {
          name: "Gone",
          email: "timeoff-removed-staff@example.com",
          role: "STAFF",
        },
      );
      await staffService.removeStaff(
        String(owner._id),
        String(business._id),
        requireMembershipId(staff),
      );

      await expect(
        staffService.createTimeOff(
          String(owner._id),
          String(business._id),
          requireMembershipId(staff),
          {
            type: "ANNUAL_HOLIDAY",
            startDate: "2026-06-05",
          },
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("no fake Time Off appears in the Staff list — Owner row always empty, new staff start with none", async () => {
      const { user: owner, business } = await createBusinessOwner(
        "owner-a@example.com",
        "Business A",
      );
      await seedStaffMember(userRepository, staffRepository, owner._id, business._id, {
        name: "Fresh Staff",
        email: "timeoff-fresh@example.com",
        role: "STAFF",
      });

      const list = await staffService.listStaff(String(owner._id), String(business._id));
      const ownerRow = list.members.find((m) => m.isOwner);
      const staffRow = list.members.find((m) => m.email === "timeoff-fresh@example.com");

      expect(ownerRow?.timeOff).toEqual([]);
      expect(staffRow?.timeOff).toEqual([]);
    });
  });
});
