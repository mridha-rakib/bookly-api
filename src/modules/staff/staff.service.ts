import mongoose from "mongoose";

import { logger } from "../../config/logger.js";
import { normalizeEmail } from "../auth/auth.utils.js";
import type { PasswordHasher } from "../auth/password-hasher.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { StaffAccessNotificationPort } from "../notification/staff-access.notifier.js";
import type { StaffAvatarService } from "../staff-avatar/staff-avatar.service.js";
import type { UserDocument, UserProfileDocument } from "../user/user.model.js";
import type { UserRepository } from "../user/user.repository.js";
import type { EmailOtpProvider } from "../verification/email-otp.provider.js";
import { StaffError } from "./staff.errors.js";
import type { StaffMembershipDocument } from "./staff.model.js";
import type { StaffRepository } from "./staff.repository.js";
import type { StaffCreatableRole, StaffDisplayRole } from "./staff.types.js";
import {
  generateTempPassword,
  joinStaffName,
  parseFreeTextPhone,
  splitStaffName,
} from "./staff.utils.js";
import type { StaffAccessEventDocument } from "./staff-access-event.model.js";
import type { StaffAccessEventRepository } from "./staff-access-event.repository.js";
import type { StaffScheduleDayDocument, StaffScheduleDocument } from "./staff-schedule.model.js";
import type { StaffScheduleRepository } from "./staff-schedule.repository.js";
import type { DayOfWeek, ScheduleDay } from "./staff-schedule.types.js";
import type { StaffTimeOffDocument } from "./staff-time-off.model.js";
import type { StaffTimeOffRepository } from "./staff-time-off.repository.js";
import type { StaffTimeOffType } from "./staff-time-off.types.js";

export type StaffTimeOffDto = {
  id: string;
  type: StaffTimeOffType;
  startDate: string;
  endDate: string;
};

export type StaffMemberDto = {
  membershipId: string | null;
  userId: string;
  businessId: string;
  name: string;
  email: string;
  phone?: { countryCode: string; nationalNumber: string; e164: string } | undefined;
  role: StaffDisplayRole;
  employmentActive: boolean;
  isOwner: boolean;
  createdAt: string;
  /** Empty for the synthesized Owner row — Owner has no schedule in this phase. */
  schedule: ScheduleDay[];
  /** Empty for the synthesized Owner row — Owner has no time off in this phase. */
  timeOff: StaffTimeOffDto[];
  avatarUrl: string | undefined;
};

export type StaffListDto = {
  businessId: string;
  members: StaffMemberDto[];
};

export type CreateStaffInput = {
  name: string;
  email: string;
  role: StaffCreatableRole;
  phone?: string | undefined;
};

export type UpdateStaffInput = {
  name?: string | undefined;
  email?: string | undefined;
  role?: StaffCreatableRole | undefined;
  phone?: string | undefined;
  employmentActive?: boolean | undefined;
};

export type PutScheduleInput = {
  days: ScheduleDay[];
};

export type CreateTimeOffInput = {
  type: StaffTimeOffType;
  startDate: string;
  endDate?: string | undefined;
};

export class StaffService {
  public constructor(
    private readonly staffRepository: StaffRepository,
    private readonly businessRepository: BusinessRepository,
    private readonly userRepository: UserRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly emailOtpProvider: EmailOtpProvider,
    private readonly staffScheduleRepository: StaffScheduleRepository,
    private readonly staffTimeOffRepository: StaffTimeOffRepository,
    private readonly staffAvatarService: StaffAvatarService,
    // Optional + trailing (never throws): emails the affected staff member after removal or an
    // access-state change. Absent in unit suites that construct this directly.
    private readonly staffAccessNotifier?: StaffAccessNotificationPort,
    // Optional + trailing: the append-only access-change audit log. When present, a ROLE_CHANGED
    // / DEACTIVATED / REACTIVATED event is inserted in the SAME transaction as the role /
    // employment write it records, and its `_id` becomes the stable email-dedupe identity.
    private readonly staffAccessEventRepository?: StaffAccessEventRepository,
  ) {}

  public async listStaff(actorUserId: string, businessId: string): Promise<StaffListDto> {
    const business = await this.requireOwnedStaffBusiness(actorUserId, businessId);
    const memberships = await this.staffRepository.listActiveByBusinessId(businessId);
    const membershipIds = memberships.map((membership) => membership._id);

    const userIds = [business.ownerUserId, ...memberships.map((membership) => membership.userId)];
    // Bounded regardless of staff count: 2 identity queries + 2 schedule/time-off queries +
    // 1 avatar batch query, all batched via $in — never one query per staff row. The Owner's
    // avatar comes through this same batch (business.ownerUserId is in userIds), with no
    // StaffMembership involved.
    const [users, profiles, schedules, timeOffs, avatarUrlByUserId] = await Promise.all([
      this.userRepository.findManyByIds(userIds),
      this.userRepository.findProfilesByUserIds(userIds),
      this.staffScheduleRepository.findManyByMembershipIds(membershipIds),
      this.staffTimeOffRepository.findManyByMembershipIds(membershipIds),
      this.staffAvatarService.getAvatarUrlsByUserIds(userIds.map(String)),
    ]);

    const userById = new Map(users.map((user) => [String(user._id), user]));
    const profileById = new Map(profiles.map((profile) => [String(profile.userId), profile]));
    const scheduleByMembershipId = new Map(
      schedules.map((schedule) => [String(schedule.membershipId), schedule]),
    );
    const timeOffByMembershipId = new Map<string, StaffTimeOffDocument[]>();
    for (const timeOff of timeOffs) {
      const key = String(timeOff.membershipId);
      const bucket = timeOffByMembershipId.get(key) ?? [];
      bucket.push(timeOff);
      timeOffByMembershipId.set(key, bucket);
    }

    const ownerRow = this.toOwnerDto(
      business,
      userById.get(String(business.ownerUserId)),
      profileById.get(String(business.ownerUserId)),
      avatarUrlByUserId.get(String(business.ownerUserId)),
    );

    const staffRows = memberships
      .map((membership) =>
        this.toMembershipDto(
          membership,
          userById.get(String(membership.userId)),
          profileById.get(String(membership.userId)),
          scheduleByMembershipId.get(String(membership._id)),
          timeOffByMembershipId.get(String(membership._id)) ?? [],
          avatarUrlByUserId.get(String(membership.userId)),
        ),
      )
      .filter((dto): dto is StaffMemberDto => dto !== null);

    return {
      businessId: String(business._id),
      members: [ownerRow, ...staffRows],
    };
  }

  public async createStaff(
    actorUserId: string,
    businessId: string,
    input: CreateStaffInput,
  ): Promise<StaffMemberDto> {
    const business = await this.requireOwnedStaffBusiness(actorUserId, businessId);

    const normalizedEmail = normalizeEmail(input.email);

    if (await this.userRepository.findByEmail(normalizedEmail)) {
      throw new StaffError("STAFF_EMAIL_ALREADY_EXISTS", 409);
    }

    let phone: ReturnType<typeof parseFreeTextPhone>;
    try {
      phone = parseFreeTextPhone(input.phone);
    } catch {
      throw new StaffError("STAFF_PHONE_INVALID", 400);
    }

    const { firstName, lastName } = splitStaffName(input.name);
    const tempPassword = generateTempPassword();
    const passwordHash = await this.passwordHasher.hash(tempPassword);

    const dbSession = await mongoose.startSession();
    let created: { user: UserDocument; membership: StaffMembershipDocument } | undefined;

    try {
      await dbSession.withTransaction(async () => {
        const user = await this.userRepository.create(
          {
            normalizedEmail,
            passwordHash,
            authProviders: ["PASSWORD"],
            role: input.role,
            status: "ACTIVE",
          },
          dbSession,
        );

        await this.userRepository.createProfile(
          {
            userId: user._id,
            firstName,
            lastName,
            gender: "other", // Add Staff form has no gender field in this phase; see report.
            ...(phone ? { phone } : {}),
          },
          dbSession,
        );

        const membership = await this.staffRepository.create(
          {
            userId: user._id,
            businessId: business._id,
            role: input.role,
            createdByUserId: new mongoose.Types.ObjectId(actorUserId),
          },
          dbSession,
        );

        created = { user, membership };
      });
    } catch (error) {
      if (this.isTransactionUnsupported(error)) {
        throw new StaffError("STAFF_TRANSACTION_UNAVAILABLE", 503);
      }

      if (this.isDuplicateKeyError(error)) {
        throw new StaffError("STAFF_EMAIL_ALREADY_EXISTS", 409);
      }

      throw error;
    } finally {
      await dbSession.endSession();
    }

    if (!created) {
      throw new Error("Staff creation failed");
    }

    // Email delivery happens after the transaction has committed — never inside it (no
    // network calls inside a Mongo transaction). If this throws, the account still exists
    // (documented behavior, matching the existing business-link-verification precedent);
    // the caller sees STAFF_TEMP_PASSWORD_EMAIL_FAILED and can advise the owner accordingly.
    try {
      await this.emailOtpProvider.sendOtp({
        to: normalizedEmail,
        code: tempPassword,
        purpose: "STAFF_TEMP_PASSWORD",
      });
    } catch {
      throw new StaffError("STAFF_TEMP_PASSWORD_EMAIL_FAILED", 502);
    }

    return {
      membershipId: String(created.membership._id),
      userId: String(created.user._id),
      businessId: String(created.membership.businessId),
      name: joinStaffName(firstName, lastName),
      email: normalizedEmail,
      phone,
      role: created.membership.role,
      employmentActive: created.membership.employmentActive,
      isOwner: false,
      createdAt: created.membership.createdAt.toISOString(),
      schedule: [],
      timeOff: [],
      // Avatar upload is a separate follow-up call the frontend makes only after this
      // create succeeds (mirrors the OTP-email-after-commit precedent above) — never
      // undefined here to imply failure, simply not-yet-uploaded.
      avatarUrl: undefined,
    };
  }

  public async updateStaff(
    actorUserId: string,
    businessId: string,
    staffId: string,
    input: UpdateStaffInput,
  ): Promise<StaffMemberDto> {
    const business = await this.requireOwnedStaffBusiness(actorUserId, businessId);
    const membership = await this.staffRepository.findActiveById(business._id, staffId);

    if (!membership) {
      throw new StaffError("STAFF_NOT_FOUND", 404);
    }

    const user = await this.userRepository.findById(membership.userId);

    if (!user) {
      throw new StaffError("STAFF_NOT_FOUND", 404);
    }

    const profile = await this.userRepository.findProfileByUserId(membership.userId);

    if (!profile) {
      throw new StaffError("STAFF_NOT_FOUND", 404);
    }

    // Access-state changes (role, active/inactive) each persist an additive StaffAccessEvent in
    // the SAME transaction as the change, and — only for a real change — feed a post-commit
    // email. A no-op (STAFF->STAFF, true->true, …) produces neither.
    const accessEvents: StaffAccessEventDocument[] = [];

    if (input.role) {
      const roleEvent = await this.updateRoleTransactionally(
        business._id,
        staffId,
        membership,
        user,
        input.role,
        actorUserId,
        membership.role,
      );
      if (roleEvent) {
        accessEvents.push(roleEvent);
      }
    }

    if (input.employmentActive !== undefined) {
      const employmentEvent = await this.updateEmploymentActiveTransactionally(
        business._id,
        staffId,
        membership,
        actorUserId,
        membership.employmentActive,
        input.employmentActive,
      );
      if (employmentEvent) {
        accessEvents.push(employmentEvent);
      }
    }

    if (input.email) {
      const normalizedEmail = normalizeEmail(input.email);

      if (normalizedEmail !== user.normalizedEmail) {
        const existing = await this.userRepository.findByEmail(normalizedEmail);

        if (existing) {
          throw new StaffError("STAFF_EMAIL_ALREADY_EXISTS", 409);
        }

        try {
          await this.userRepository.updateEmail(user._id, normalizedEmail);
          user.normalizedEmail = normalizedEmail;
        } catch (error) {
          if (this.isDuplicateKeyError(error)) {
            throw new StaffError("STAFF_EMAIL_ALREADY_EXISTS", 409);
          }

          throw error;
        }
      }
    }

    let phone = profile.phone;
    if (input.phone !== undefined) {
      try {
        phone = parseFreeTextPhone(input.phone);
      } catch {
        throw new StaffError("STAFF_PHONE_INVALID", 400);
      }
    }

    if (input.name || input.phone !== undefined) {
      const { firstName, lastName } = input.name
        ? splitStaffName(input.name)
        : { firstName: profile.firstName, lastName: profile.lastName };

      await this.userRepository.updateProfile(profile._id, { firstName, lastName, phone });
      profile.firstName = firstName;
      profile.lastName = lastName;
      profile.phone = phone;
    }

    const [schedule, timeOff, avatarUrlByUserId] = await Promise.all([
      this.staffScheduleRepository.findByMembershipId(membership._id),
      this.staffTimeOffRepository.listByMembershipId(membership._id),
      this.staffAvatarService.getAvatarUrlsByUserIds([String(membership.userId)]),
    ]);

    // Best-effort, strictly AFTER every write above has committed. One email per persisted
    // access event; never blocks or rolls back the staff update.
    for (const event of accessEvents) {
      await this.dispatchStaffAccessChangeNotification(event, business.name);
    }

    return this.toMembershipDto(
      membership,
      user,
      profile,
      schedule ?? undefined,
      timeOff,
      avatarUrlByUserId.get(String(membership.userId)),
    ) as StaffMemberDto;
  }

  private async dispatchStaffAccessChangeNotification(
    event: StaffAccessEventDocument,
    businessName: string,
  ): Promise<void> {
    if (!this.staffAccessNotifier) {
      return;
    }
    try {
      await this.staffAccessNotifier.notifyStaffAccessChanged({
        eventId: String(event._id),
        type: event.type,
        staffUserId: String(event.staffUserId),
        businessName,
        ...(event.previousRole ? { previousRole: event.previousRole } : {}),
        ...(event.newRole ? { newRole: event.newRole } : {}),
      });
    } catch (error) {
      logger.error(
        { err: error, eventId: String(event._id) },
        "Failed to dispatch staff access-change notification (the staff change is unaffected)",
      );
    }
  }

  /**
   * StaffMembership.role and User.role are two independent documents in two different
   * collections that must never disagree — the Booking module's authorization check reads
   * both. Wrapped in a transaction so a mid-write failure (e.g. a dropped connection between
   * the two updates) can never leave one collection updated and the other stale — either both
   * roles move together or neither does.
   *
   * ADDITIVE (this phase): when a `staffAccessEventRepository` is wired AND the role actually
   * changed (`previousRole !== role`), a `ROLE_CHANGED` `StaffAccessEvent` is inserted inside
   * this SAME transaction and returned, so its `_id` can key the follow-up email. A no-op
   * role "change" persists nothing new and returns `null`. The dual-write semantics above are
   * untouched.
   */
  private async updateRoleTransactionally(
    businessId: BusinessDocument["_id"],
    staffId: string,
    membership: StaffMembershipDocument,
    user: UserDocument,
    role: StaffCreatableRole,
    changedByUserId: string,
    previousRole: StaffCreatableRole,
  ): Promise<StaffAccessEventDocument | null> {
    const dbSession = await mongoose.startSession();
    let accessEvent: StaffAccessEventDocument | null = null;

    try {
      await dbSession.withTransaction(async () => {
        // Reset on withTransaction's own retry-on-TransientTransactionError, so an aborted
        // attempt never leaks a stale event document out of here.
        accessEvent = null;

        const updatedMembership = await this.staffRepository.updateActiveById(
          businessId,
          staffId,
          { role },
          dbSession,
        );

        if (!updatedMembership) {
          // Membership was removed by a concurrent request between the initial fetch above
          // and this write — abort rather than proceeding to update User.role alone, which
          // is exactly the split-brain this transaction exists to prevent.
          throw new StaffError("STAFF_NOT_FOUND", 404);
        }

        membership.role = updatedMembership.role;

        if (user.role !== role) {
          await this.userRepository.updateRole(user._id, role, dbSession);
          user.role = role;
        }

        if (this.staffAccessEventRepository && previousRole !== role) {
          accessEvent = await this.staffAccessEventRepository.create(
            {
              businessId,
              staffMembershipId: updatedMembership._id,
              staffUserId: membership.userId,
              type: "ROLE_CHANGED",
              changedByUserId: new mongoose.Types.ObjectId(changedByUserId),
              previousRole,
              newRole: role,
            },
            dbSession,
          );
        }
      });
    } catch (error) {
      if (this.isTransactionUnsupported(error)) {
        throw new StaffError("STAFF_TRANSACTION_UNAVAILABLE", 503);
      }

      throw error;
    } finally {
      await dbSession.endSession();
    }

    return accessEvent;
  }

  /**
   * Sets `employmentActive` and — when it actually flips AND a `staffAccessEventRepository` is
   * wired — inserts a `DEACTIVATED` / `REACTIVATED` `StaffAccessEvent` in the SAME transaction,
   * so the membership write and its audit record commit atomically (an event-insert failure
   * rolls the flag back too). The field value / guard / result are exactly as before; the only
   * added constraint is that this now needs a transaction-capable server, matching the role
   * path above. A no-op (`previousActive === nextActive`) writes no event and returns `null`.
   */
  private async updateEmploymentActiveTransactionally(
    businessId: BusinessDocument["_id"],
    staffId: string,
    membership: StaffMembershipDocument,
    changedByUserId: string,
    previousActive: boolean,
    nextActive: boolean,
  ): Promise<StaffAccessEventDocument | null> {
    const dbSession = await mongoose.startSession();
    let accessEvent: StaffAccessEventDocument | null = null;

    try {
      await dbSession.withTransaction(async () => {
        accessEvent = null;

        const updatedMembership = await this.staffRepository.updateActiveById(
          businessId,
          staffId,
          { employmentActive: nextActive },
          dbSession,
        );

        if (updatedMembership) {
          membership.employmentActive = updatedMembership.employmentActive;
        }

        if (updatedMembership && this.staffAccessEventRepository && previousActive !== nextActive) {
          accessEvent = await this.staffAccessEventRepository.create(
            {
              businessId,
              staffMembershipId: updatedMembership._id,
              staffUserId: membership.userId,
              type: nextActive ? "REACTIVATED" : "DEACTIVATED",
              changedByUserId: new mongoose.Types.ObjectId(changedByUserId),
              previousEmploymentActive: previousActive,
              newEmploymentActive: nextActive,
            },
            dbSession,
          );
        }
      });
    } catch (error) {
      if (this.isTransactionUnsupported(error)) {
        throw new StaffError("STAFF_TRANSACTION_UNAVAILABLE", 503);
      }

      throw error;
    } finally {
      await dbSession.endSession();
    }

    return accessEvent;
  }

  public async removeStaff(
    actorUserId: string,
    businessId: string,
    staffId: string,
  ): Promise<void> {
    const business = await this.requireOwnedStaffBusiness(actorUserId, businessId);
    const removed = await this.staffRepository.softRemoveById(business._id, staffId);

    if (!removed) {
      throw new StaffError("STAFF_NOT_FOUND", 404);
    }

    // Intentionally does NOT touch User/UserProfile and does NOT touch User.status —
    // identity + login capability survive removal; only the employment membership ends.
    // Schedule/time-off are intentionally left in place too (not deleted) — they remain
    // available for future booking-history reference, same rationale as identity survival.

    // Best-effort staff notification, strictly AFTER the soft-remove has persisted. `removedAt`
    // is written exactly once (repo guards on `removedAt: {$exists:false}`), so a retried remove
    // 404s above and never re-notifies. Never blocks the response.
    await this.dispatchStaffRemovedNotification(removed, business.name);
  }

  private async dispatchStaffRemovedNotification(
    membership: StaffMembershipDocument,
    businessName: string,
  ): Promise<void> {
    if (!this.staffAccessNotifier) {
      return;
    }
    try {
      await this.staffAccessNotifier.notifyStaffRemoved({
        membershipId: String(membership._id),
        userId: String(membership.userId),
        businessName,
      });
    } catch (error) {
      logger.error(
        { err: error, membershipId: String(membership._id) },
        "Failed to dispatch STAFF_ACCESS_REMOVED notification (the staff removal is unaffected)",
      );
    }
  }

  public async getSchedule(
    actorUserId: string,
    businessId: string,
    staffId: string,
  ): Promise<ScheduleDay[]> {
    const membership = await this.requireActiveMembership(actorUserId, businessId, staffId);
    const schedule = await this.staffScheduleRepository.findByMembershipId(membership._id);
    return this.toScheduleDayDtos(schedule ?? undefined);
  }

  /**
   * Replaces the whole week in one write. This is what enforces "at most one shift per
   * day" — there is no per-day upsert that could accumulate a second interval — and it is
   * also how the existing single "Save changes" button can update schedule alongside core
   * identity without a separate visible Save control (see staff.route.ts / frontend).
   */
  public async putSchedule(
    actorUserId: string,
    businessId: string,
    staffId: string,
    input: PutScheduleInput,
  ): Promise<ScheduleDay[]> {
    const business = await this.requireOwnedStaffBusiness(actorUserId, businessId);
    const membership = await this.requireActiveMembershipForBusiness(business, staffId);

    // Defense in depth beyond the schema's duplicate-day check: dedupe by keeping the last
    // entry per day, so this can never persist two shifts for the same day even if a caller
    // bypasses the schema layer directly against the service.
    const byDay = new Map<DayOfWeek, ScheduleDay>();
    for (const day of input.days) {
      byDay.set(day.dayOfWeek, day);
    }

    const days: StaffScheduleDayDocument[] = [...byDay.values()].map((day) => ({
      dayOfWeek: day.dayOfWeek,
      startTime: day.startTime,
      endTime: day.endTime,
    }));

    const schedule = await this.staffScheduleRepository.replace(membership._id, business._id, days);

    return this.toScheduleDayDtos(schedule);
  }

  public async listTimeOff(
    actorUserId: string,
    businessId: string,
    staffId: string,
  ): Promise<StaffTimeOffDto[]> {
    const membership = await this.requireActiveMembership(actorUserId, businessId, staffId);
    const entries = await this.staffTimeOffRepository.listByMembershipId(membership._id);
    return entries.map((entry) => this.toTimeOffDto(entry));
  }

  public async createTimeOff(
    actorUserId: string,
    businessId: string,
    staffId: string,
    input: CreateTimeOffInput,
  ): Promise<StaffTimeOffDto> {
    const business = await this.requireOwnedStaffBusiness(actorUserId, businessId);
    const membership = await this.requireActiveMembershipForBusiness(business, staffId);

    // Single-day leave is startDate === endDate — no separate single/range representation.
    // (endDate >= startDate is already enforced by createStaffTimeOffBodySchema.)
    const startDate = input.startDate;
    const endDate = input.endDate ?? input.startDate;

    const existing = await this.staffTimeOffRepository.listByMembershipId(membership._id);
    const overlaps = existing.some(
      (entry) => startDate <= entry.endDate && endDate >= entry.startDate,
    );

    if (overlaps) {
      throw new StaffError("STAFF_TIME_OFF_OVERLAP", 409);
    }

    const created = await this.staffTimeOffRepository.create({
      membershipId: membership._id,
      businessId: business._id,
      type: input.type,
      startDate,
      endDate,
      createdByUserId: new mongoose.Types.ObjectId(actorUserId),
    });

    return this.toTimeOffDto(created);
  }

  public async removeTimeOff(
    actorUserId: string,
    businessId: string,
    staffId: string,
    timeOffId: string,
  ): Promise<void> {
    const business = await this.requireOwnedStaffBusiness(actorUserId, businessId);
    const membership = await this.requireActiveMembershipForBusiness(business, staffId);

    const deleted = await this.staffTimeOffRepository.deleteByIdForMembership(
      membership._id,
      timeOffId,
    );

    if (!deleted) {
      throw new StaffError("STAFF_TIME_OFF_NOT_FOUND", 404);
    }

    // Does not touch User, StaffMembership, or employmentActive — pure leave-record removal.
  }

  /** Resolves + authorizes a Business, then resolves an active (not removed) membership on it. */
  private async requireActiveMembership(
    actorUserId: string,
    businessId: string,
    staffId: string,
  ): Promise<StaffMembershipDocument> {
    const business = await this.requireOwnedStaffBusiness(actorUserId, businessId);
    return this.requireActiveMembershipForBusiness(business, staffId);
  }

  private async requireActiveMembershipForBusiness(
    business: BusinessDocument,
    staffId: string,
  ): Promise<StaffMembershipDocument> {
    const membership = await this.staffRepository.findActiveById(business._id, staffId);

    if (!membership) {
      // Covers: unknown id, removed staff, and staff belonging to a different Business —
      // findActiveById already scopes by businessId, so this also blocks cross-business
      // schedule/time-off mutation.
      throw new StaffError("STAFF_NOT_FOUND", 404);
    }

    return membership;
  }

  /**
   * Staff-Management-specific authorization: an actor may manage staff ONLY for a Business
   * they actually own (Business.ownerUserId === actorUserId). BusinessAccess (linked
   * Business) is deliberately never consulted here — a Secondary/linked Business grants no
   * Staff-management rights, even though it remains valid for other Bookly features. Forged
   * or unrelated businessId values are denied.
   *
   * 404 (never a bare 403) on every mismatch — nonexistent business and existing-business-
   * owned-by-someone-else are intentionally indistinguishable, matching the anti-enumeration
   * convention every other management surface (Client, Service, Addon, Booking) already
   * follows. A forged businessId must never let a caller learn whether it belongs to someone
   * else versus not existing at all.
   */
  private async requireOwnedStaffBusiness(
    actorUserId: string,
    businessId: string,
  ): Promise<BusinessDocument> {
    this.requireValidObjectId(businessId);
    const business = await this.businessRepository.findById(businessId);

    if (!business) {
      throw new StaffError("STAFF_BUSINESS_NOT_FOUND", 404);
    }

    if (!business.ownerUserId.equals(actorUserId)) {
      throw new StaffError("STAFF_BUSINESS_NOT_FOUND", 404);
    }

    return business;
  }

  private toOwnerDto(
    business: BusinessDocument,
    user: UserDocument | undefined,
    profile: UserProfileDocument | undefined,
    avatarUrl: string | undefined,
  ): StaffMemberDto {
    return {
      membershipId: null,
      userId: String(business.ownerUserId),
      businessId: String(business._id),
      name: profile ? joinStaffName(profile.firstName, profile.lastName) : business.ownerName,
      email: user?.normalizedEmail ?? business.email,
      phone: profile?.phone,
      role: "BUSINESS_OWNER",
      employmentActive: true,
      isOwner: true,
      createdAt: business.createdAt.toISOString(),
      // The Owner row is synthesized, never a StaffMembership — it has no schedule/time-off
      // to manage in this phase, and none is ever fabricated here.
      schedule: [],
      timeOff: [],
      avatarUrl,
    };
  }

  private toMembershipDto(
    membership: StaffMembershipDocument,
    user: UserDocument | undefined,
    profile: UserProfileDocument | undefined,
    schedule: StaffScheduleDocument | undefined,
    timeOff: StaffTimeOffDocument[],
    avatarUrl: string | undefined,
  ): StaffMemberDto | null {
    if (!user || !profile) {
      // Identity row missing (should not happen under normal operation); skip rather than
      // render a broken card.
      return null;
    }

    return {
      membershipId: String(membership._id),
      userId: String(membership.userId),
      businessId: String(membership.businessId),
      name: joinStaffName(profile.firstName, profile.lastName),
      email: user.normalizedEmail,
      phone: profile.phone,
      role: membership.role,
      employmentActive: membership.employmentActive,
      isOwner: false,
      createdAt: membership.createdAt.toISOString(),
      schedule: this.toScheduleDayDtos(schedule),
      timeOff: timeOff.map((entry) => this.toTimeOffDto(entry)),
      avatarUrl,
    };
  }

  private toScheduleDayDtos(schedule: StaffScheduleDocument | undefined): ScheduleDay[] {
    if (!schedule) {
      return [];
    }

    return schedule.days.map((day: StaffScheduleDayDocument) => ({
      dayOfWeek: day.dayOfWeek,
      startTime: day.startTime,
      endTime: day.endTime,
    }));
  }

  private toTimeOffDto(entry: StaffTimeOffDocument): StaffTimeOffDto {
    return {
      id: String(entry._id),
      type: entry.type,
      startDate: entry.startDate,
      endDate: entry.endDate,
    };
  }

  private requireValidObjectId(value: string): void {
    if (!/^[a-f\d]{24}$/i.test(value)) {
      throw new StaffError("STAFF_BUSINESS_NOT_FOUND", 404);
    }
  }

  private isTransactionUnsupported(error: unknown): boolean {
    return (
      error instanceof Error &&
      /transaction numbers are only allowed|replica set member/i.test(error.message)
    );
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}
