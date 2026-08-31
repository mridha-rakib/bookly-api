import type { Types } from "mongoose";

import { logger } from "../../config/logger.js";
import type { StaffAccessRemovedPayload } from "../email/templates/staff/staff-access-removed.template.js";
import type { StaffDeactivatedPayload } from "../email/templates/staff/staff-deactivated.template.js";
import type { StaffReactivatedPayload } from "../email/templates/staff/staff-reactivated.template.js";
import type { StaffRoleChangedPayload } from "../email/templates/staff/staff-role-changed.template.js";
import type { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import { normalizeRecipient } from "./notification-recipients.js";

type OutboxEnqueue = Pick<EmailOutboxService, "enqueue">;

/** Persisted-enum -> user-facing label. The only two staff-assignable roles. */
const roleLabel = (role: "STAFF" | "SUPERVISOR"): string =>
  role === "SUPERVISOR" ? "Supervisor" : "Staff";

/**
 * Compact, JSON-safe view of a persisted `StaffAccessEvent` — the ONLY thing the service hands
 * the notifier. No StaffMembership / User / Business documents cross this boundary.
 */
export type StaffAccessChangePresentation = {
  /** The persisted `StaffAccessEvent._id` — the stable, unique email-dedupe identity. */
  eventId: string;
  type: "ROLE_CHANGED" | "DEACTIVATED" | "REACTIVATED";
  staffUserId: string;
  businessName: string;
  /** ROLE_CHANGED only — persisted role enum values. */
  previousRole?: "STAFF" | "SUPERVISOR" | undefined;
  newRole?: "STAFF" | "SUPERVISOR" | undefined;
};

export type StaffAccessRecipientUserPort = {
  findManyByIds(
    ids: Array<Types.ObjectId | string>,
  ): Promise<Array<{ _id: unknown; normalizedEmail: string }>>;
  findProfilesByUserIds(
    ids: string[],
  ): Promise<Array<{ userId: unknown; firstName: string; lastName: string }>>;
};

/**
 * Optional observer port on `StaffService` — the one important staff admin-action email:
 * "your team access was removed", fired only after `StaffService.removeStaff` has committed the
 * soft-remove. `removedAt` is written exactly once (the repository guards on `removedAt:
 * {$exists:false}`), so `membershipId` alone is a permanently stable event identity and a
 * retried remove (which 404s) enqueues nothing new. Never throws.
 */
export type StaffAccessNotificationPort = {
  notifyStaffRemoved(input: {
    membershipId: string;
    userId: string;
    businessName: string;
  }): Promise<void>;
  /**
   * Emails the affected staff member after a role / deactivate / reactivate change has
   * committed alongside its `StaffAccessEvent`. Exactly one row per event; `eventId` makes a
   * retried call a no-op via the EmailOutbox unique index, while a genuinely new event (the
   * next STAFF<->SUPERVISOR flip, or the next activate/deactivate) has a new id and legitimately
   * sends again. Never throws.
   */
  notifyStaffAccessChanged(change: StaffAccessChangePresentation): Promise<void>;
};

export class StaffAccessNotifier implements StaffAccessNotificationPort {
  public constructor(
    private readonly emailOutbox: OutboxEnqueue,
    private readonly users: StaffAccessRecipientUserPort,
  ) {}

  public async notifyStaffRemoved(input: {
    membershipId: string;
    userId: string;
    businessName: string;
  }): Promise<void> {
    try {
      const [users, profiles] = await Promise.all([
        this.users.findManyByIds([input.userId]),
        this.users.findProfilesByUserIds([input.userId]),
      ]);
      const email = normalizeRecipient(users[0]?.normalizedEmail ?? "");
      if (!email) {
        logger.warn(
          { membershipId: input.membershipId },
          "Removed staff member has no resolvable email — skipping STAFF_ACCESS_REMOVED notification",
        );
        return;
      }

      const payload: StaffAccessRemovedPayload = {
        staffFirstName: profiles[0]?.firstName || "there",
        businessName: input.businessName,
      };

      await this.emailOutbox.enqueue({
        eventKey: `STAFF_ACCESS_REMOVED:${input.membershipId}`,
        templateKey: "STAFF_ACCESS_REMOVED",
        recipient: email,
        payload: payload as unknown as Record<string, unknown>,
      });
    } catch (error) {
      logger.error(
        { err: error, membershipId: input.membershipId },
        "Failed to enqueue STAFF_ACCESS_REMOVED notification (the staff removal is unaffected)",
      );
    }
  }

  public async notifyStaffAccessChanged(change: StaffAccessChangePresentation): Promise<void> {
    try {
      const [users, profiles] = await Promise.all([
        this.users.findManyByIds([change.staffUserId]),
        this.users.findProfilesByUserIds([change.staffUserId]),
      ]);
      const email = normalizeRecipient(users[0]?.normalizedEmail ?? "");
      if (!email) {
        logger.warn(
          { eventId: change.eventId, type: change.type },
          "Affected staff member has no resolvable email — skipping staff access-change notification",
        );
        return;
      }
      const staffFirstName = profiles[0]?.firstName || "there";

      if (change.type === "ROLE_CHANGED") {
        if (!change.previousRole || !change.newRole) {
          return;
        }
        const payload: StaffRoleChangedPayload = {
          staffFirstName,
          businessName: change.businessName,
          previousRole: roleLabel(change.previousRole),
          newRole: roleLabel(change.newRole),
        };
        await this.emailOutbox.enqueue({
          eventKey: `STAFF_ROLE_CHANGED:${change.eventId}`,
          templateKey: "STAFF_ROLE_CHANGED",
          recipient: email,
          payload: payload as unknown as Record<string, unknown>,
        });
        return;
      }

      const payload: StaffDeactivatedPayload | StaffReactivatedPayload = {
        staffFirstName,
        businessName: change.businessName,
      };
      await this.emailOutbox.enqueue({
        eventKey: `STAFF_${change.type}:${change.eventId}`,
        templateKey: change.type === "DEACTIVATED" ? "STAFF_DEACTIVATED" : "STAFF_REACTIVATED",
        recipient: email,
        payload: payload as unknown as Record<string, unknown>,
      });
    } catch (error) {
      logger.error(
        { err: error, eventId: change.eventId, type: change.type },
        "Failed to enqueue staff access-change notification (the staff change is unaffected)",
      );
    }
  }
}
