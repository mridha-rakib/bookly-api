import mongoose from "mongoose";

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { normalizeEmail } from "../auth/auth.utils.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { StaffAccessNotificationPort } from "../notification/staff-access.notifier.js";
import { StaffInvitationNotifier } from "../notification/staff-invitation.notifier.js";
import type { PackageProgressRepository } from "../package-progress/package-progress.repository.js";
import type { ServiceRepository } from "../services/service.repository.js";
import type { StaffAvatarService } from "../staff-avatar/staff-avatar.service.js";
import type { StaffInvitationDocument } from "../staff-invitation/staff-invitation.model.js";
import type { StaffInvitationService } from "../staff-invitation/staff-invitation.service.js";
import type { UserDocument, UserProfileDocument } from "../user/user.model.js";
import type { UserRepository } from "../user/user.repository.js";
import type { EmailOtpProvider } from "../verification/email-otp.provider.js";
import { StaffError } from "./staff.errors.js";
import type { StaffMembershipDocument } from "./staff.model.js";
import type { StaffRepository } from "./staff.repository.js";
import type { StaffCreatableRole, StaffDisplayRole } from "./staff.types.js";
import { joinStaffName, parseFreeTextPhone, splitStaffName } from "./staff.utils.js";
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

/** Staff self-service "my assigned services" — a deliberately minimal read (id/name/category/
 * status), not the full owner-facing Service shape service.service.ts already returns. */
export type StaffAssignedServiceDto = {
  id: string;
  name: string;
  category: string;
  subcategory?: string | undefined;
  status: string;
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

/** A still-PENDING invitation shown alongside real members on the Staff screen (Phase 2D). No
 * User / StaffMembership exists yet — the person has not accepted. */
export type PendingStaffInvitationDto = {
  invitationId: string;
  businessId: string;
  email: string;
  name: string;
  role: StaffCreatableRole;
  status: "PENDING";
  invitedAt: string;
  expiresAt: string;
};

export type StaffListDto = {
  businessId: string;
  members: StaffMemberDto[];
  /** PENDING invitations (Phase 2D). Empty until someone is invited but has not yet accepted. */
  invitations: PendingStaffInvitationDto[];
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
    // Phase 2D — "Add staff" now issues an invitation instead of creating a temp-password User.
    // This service no longer hashes passwords (acceptance does, in staff-invitation).
    private readonly staffInvitationService: StaffInvitationService,
    // Still used for the invitation link email (branded plain-notice transport — same one the
    // former temp-password email used), via a lazily-built StaffInvitationNotifier.
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
    // Optional + trailing, same rationale as the other optional deps above: only needed for
    // the Staff self-service "my assigned services" read. Absent in unit suites that don't
    // exercise that path.
    private readonly serviceRepository?: Pick<
      ServiceRepository,
      "listActiveByAssignedStaffMembershipId"
    >,
    // Optional + trailing, same rationale: only needed to enforce the approved Package Deal
    // staff-removal protection below. Absent in unit suites that don't exercise it.
    private readonly packageProgressRepository?: Pick<
      PackageProgressRepository,
      "hasOutstandingEntitlementsForService"
    >,
  ) {}

  /**
   * Approved rule: removing (soft-remove) or deactivating (employmentActive -> false) the FINAL
   * eligible staff member for a Package Deal Service that still has outstanding (unused,
   * unvoided) Package entitlements is blocked outright — it would leave paying customers with no
   * usable professional to redeem their remaining sessions against. "Eligible" mirrors
   * AvailabilityService.resolveEligibleStaff's own definition exactly: assigned to the Service
   * AND `employmentActive && !removedAt` — reused here rather than re-derived. Never
   * auto-reassigns or invents a substitute — the caller must assign another eligible staff
   * member (or wait for the entitlement to be used/voided) before this action is allowed.
   * A no-op when either optional dependency is absent (matches every other optional-dependency
   * feature in this class) or the membership is assigned to no Package Deal service.
   */
  private async assertPackageStaffRemovalSafe(
    business: BusinessDocument,
    membershipId: string,
  ): Promise<void> {
    if (!this.serviceRepository || !this.packageProgressRepository) {
      return;
    }

    const assignedServices = await this.serviceRepository.listActiveByAssignedStaffMembershipId(
      business._id,
      membershipId,
    );

    for (const service of assignedServices) {
      if (!service.isPackageDeal) {
        continue;
      }

      const hasOutstanding =
        await this.packageProgressRepository.hasOutstandingEntitlementsForService(
          business._id,
          service._id,
        );
      if (!hasOutstanding) {
        continue;
      }

      const otherAssignedIds = service.assignedStaffMembershipIds.filter(
        (id) => String(id) !== String(membershipId),
      );
      const otherMemberships =
        otherAssignedIds.length > 0
          ? await this.staffRepository.findManyByIdsForBusiness(business._id, otherAssignedIds)
          : [];
      const otherEligible = otherMemberships.filter(
        (membership) => membership.employmentActive && !membership.removedAt,
      );

      if (otherEligible.length === 0) {
        throw new StaffError("STAFF_REMOVAL_BLOCKED_BY_PACKAGE_ENTITLEMENTS", 409);
      }
    }
  }

  public async listStaff(actorUserId: string, businessId: string): Promise<StaffListDto> {
    const business = await this.requireOwnedOrSupervisedStaffBusiness(actorUserId, businessId);
    const [memberships, pendingInvitations] = await Promise.all([
      this.staffRepository.listActiveByBusinessId(businessId),
      this.staffInvitationService.listPendingForBusiness(business._id),
    ]);
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
      invitations: pendingInvitations.map((invitation) => this.toPendingInvitationDto(invitation)),
    };
  }

  /**
   * Phase 2D — "Add staff" no longer creates a User. It issues a PENDING {@link StaffInvitation}
   * and emails the invitee a one-time link; the User + UserProfile + StaffMembership are created
   * later, in one transaction, when they accept (password or Google) — see
   * StaffInvitationAcceptService. Returns a pending-invitation DTO, never a member row.
   */
  public async createStaff(
    actorUserId: string,
    businessId: string,
    input: CreateStaffInput,
  ): Promise<PendingStaffInvitationDto> {
    const business = await this.requireOwnedStaffBusiness(actorUserId, businessId);

    const normalizedEmail = normalizeEmail(input.email);

    // Early feedback for a garbled phone even though the invitation itself stores no phone —
    // the invitee supplies their own at acceptance.
    try {
      parseFreeTextPhone(input.phone);
    } catch {
      throw new StaffError("STAFF_PHONE_INVALID", 400);
    }

    const { firstName, lastName } = splitStaffName(input.name);

    // Issue rejects an email already on a User (STAFF_INVITATION_EMAIL_IN_USE) or an already-
    // pending invitation for this (business, email) — both surface as their own 409s.
    const { invitation, token } = await this.staffInvitationService.issue({
      businessId: business._id,
      invitedByUserId: new mongoose.Types.ObjectId(actorUserId),
      email: normalizedEmail,
      role: input.role,
      firstName,
      lastName,
    });

    // Link email delivery — mirrors the former temp-password send: after the row is persisted,
    // and a failure surfaces as STAFF_INVITATION_EMAIL_FAILED (the invitation still exists and
    // the owner can "resend").
    try {
      await this.invitationNotifier().send({
        to: normalizedEmail,
        businessName: business.name,
        role: invitation.role,
        acceptUrl: this.buildAcceptUrl(token),
        expiresInText: this.expiresInText(invitation.expiresAt),
      });
    } catch {
      throw new StaffError("STAFF_INVITATION_EMAIL_FAILED", 502);
    }

    return this.toPendingInvitationDto(invitation);
  }

  /** Owner re-sends a still-pending invitation with a fresh link + reset expiry. */
  public async resendInvitation(
    actorUserId: string,
    businessId: string,
    invitationId: string,
  ): Promise<PendingStaffInvitationDto> {
    const business = await this.requireOwnedStaffBusiness(actorUserId, businessId);

    const { invitation, token } = await this.staffInvitationService.resend({
      invitationId,
      businessId: business._id,
    });

    try {
      await this.invitationNotifier().send({
        to: invitation.email,
        businessName: business.name,
        role: invitation.role,
        acceptUrl: this.buildAcceptUrl(token),
        expiresInText: this.expiresInText(invitation.expiresAt),
      });
    } catch {
      throw new StaffError("STAFF_INVITATION_EMAIL_FAILED", 502);
    }

    return this.toPendingInvitationDto(invitation);
  }

  /** Owner cancels a still-pending invitation. */
  public async revokeInvitation(
    actorUserId: string,
    businessId: string,
    invitationId: string,
  ): Promise<void> {
    const business = await this.requireOwnedStaffBusiness(actorUserId, businessId);
    await this.staffInvitationService.revoke({ invitationId, businessId: business._id });
  }

  private invitationNotifier(): StaffInvitationNotifier {
    return new StaffInvitationNotifier(this.emailOtpProvider);
  }

  private buildAcceptUrl(token: string): string {
    return `${env.FRONTEND_BASE_URL}/staff/invite/accept?token=${encodeURIComponent(token)}`;
  }

  private expiresInText(expiresAt: Date): string {
    const hours = Math.round((expiresAt.getTime() - Date.now()) / (60 * 60 * 1000));
    if (hours >= 24) {
      const days = Math.round(hours / 24);
      return `in ${days} day${days === 1 ? "" : "s"}`;
    }
    return `in ${Math.max(hours, 1)} hour${hours === 1 ? "" : "s"}`;
  }

  private toPendingInvitationDto(invitation: StaffInvitationDocument): PendingStaffInvitationDto {
    return {
      invitationId: String(invitation._id),
      businessId: String(invitation.businessId),
      email: invitation.email,
      name: joinStaffName(
        invitation.firstName ?? invitation.email,
        invitation.lastName ?? invitation.email,
      ),
      role: invitation.role,
      status: "PENDING",
      invitedAt: invitation.createdAt.toISOString(),
      expiresAt: invitation.expiresAt.toISOString(),
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

    if (input.employmentActive === false && membership.employmentActive) {
      await this.assertPackageStaffRemovalSafe(business, staffId);
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
    await this.assertPackageStaffRemovalSafe(business, staffId);
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
   * Staff/Supervisor self-service — read the caller's OWN schedule via their own active
   * StaffMembership (resolved from `actorUserId`, never from a `staffId` the caller could
   * substitute). `businessId` is only checked to match the caller's own membership so a
   * mismatched URL path 404s rather than silently ignoring it — it is never used to look up
   * someone else's membership. No write path exists here; Owner/Supervisor mutation of a
   * schedule stays exclusively on {@link putSchedule}.
   */
  public async getMySchedule(actorUserId: string, businessId: string): Promise<ScheduleDay[]> {
    const membership = await this.requireOwnMembershipForBusiness(actorUserId, businessId);
    const schedule = await this.staffScheduleRepository.findByMembershipId(membership._id);
    return this.toScheduleDayDtos(schedule ?? undefined);
  }

  /** Staff/Supervisor self-service — read the Services assigned to the caller's OWN
   * StaffMembership. See {@link getMySchedule} for the same self-only resolution rule. */
  public async listMyAssignedServices(
    actorUserId: string,
    businessId: string,
  ): Promise<StaffAssignedServiceDto[]> {
    const membership = await this.requireOwnMembershipForBusiness(actorUserId, businessId);

    if (!this.serviceRepository) {
      return [];
    }

    const services = await this.serviceRepository.listActiveByAssignedStaffMembershipId(
      membership.businessId,
      membership._id,
    );

    return services.map((service) => ({
      id: String(service._id),
      name: service.name,
      category: service.category,
      subcategory: service.subcategory,
      status: service.status,
    }));
  }

  /** Resolves the caller's own active StaffMembership and confirms it belongs to the requested
   * `businessId` — the shared authorization step behind every Staff/Supervisor self-service
   * read (getMySchedule, listMyAssignedServices). 404s (never 403) on any mismatch, matching
   * the anti-enumeration convention the rest of this service already follows. */
  private async requireOwnMembershipForBusiness(
    actorUserId: string,
    businessId: string,
  ): Promise<StaffMembershipDocument> {
    this.requireValidObjectId(businessId);
    const membership = await this.staffRepository.findActiveByUserId(actorUserId);

    if (!membership?.businessId.equals(businessId)) {
      throw new StaffError("STAFF_NOT_FOUND", 404);
    }

    return membership;
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
    const business = await this.requireOwnedOrSupervisedStaffBusiness(actorUserId, businessId);
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
    const business = await this.requireOwnedOrSupervisedStaffBusiness(actorUserId, businessId);
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
    const business = await this.requireOwnedOrSupervisedStaffBusiness(actorUserId, businessId);
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

  /**
   * Resolves + authorizes a Business (Owner or Supervisor — see
   * requireOwnedOrSupervisedStaffBusiness), then resolves an active (not removed) membership
   * on it. Used only by the two read paths (getSchedule, listTimeOff); the three write paths
   * (putSchedule, createTimeOff, removeTimeOff) call requireOwnedOrSupervisedStaffBusiness
   * directly since they also need the resolved `business` for other work.
   */
  private async requireActiveMembership(
    actorUserId: string,
    businessId: string,
    staffId: string,
  ): Promise<StaffMembershipDocument> {
    const business = await this.requireOwnedOrSupervisedStaffBusiness(actorUserId, businessId);
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

  /**
   * Read/schedule authorization for the surfaces Supervisor is allowed on (staff list read,
   * schedule read/write, time-off read/write) — Owner keeps full access via
   * {@link requireOwnedStaffBusiness}'s ownership check; an active SUPERVISOR membership of
   * this exact Business is additionally allowed. Deliberately NOT used by core staff-identity
   * methods (create/update/remove staff, invitations) — those stay Owner-only via
   * requireOwnedStaffBusiness, unchanged. Same 404-not-403 anti-enumeration convention as
   * requireOwnedStaffBusiness for every rejection path.
   */
  private async requireOwnedOrSupervisedStaffBusiness(
    actorUserId: string,
    businessId: string,
  ): Promise<BusinessDocument> {
    this.requireValidObjectId(businessId);
    const business = await this.businessRepository.findById(businessId);

    if (!business) {
      throw new StaffError("STAFF_BUSINESS_NOT_FOUND", 404);
    }

    if (business.ownerUserId.equals(actorUserId)) {
      return business;
    }

    const membership = await this.staffRepository.findActiveByUserId(actorUserId);

    if (
      membership &&
      membership.role === "SUPERVISOR" &&
      membership.businessId.equals(business._id)
    ) {
      return business;
    }

    throw new StaffError("STAFF_BUSINESS_NOT_FOUND", 404);
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
