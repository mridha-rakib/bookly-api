import { Types } from "mongoose";

import { logger } from "../../config/logger.js";
import type { UserDocument, UserStatusAction, UserStatusHistoryEntry } from "../user/user.model.js";
import type { UserRepository } from "../user/user.repository.js";
import type { UserRole, UserStatus } from "../user/user.types.js";
import { SuperAdminError } from "./super-admin.errors.js";

export type CustomerStatusActor = { userId: string; role: UserRole };

export type CustomerStatusChangeDto = {
  action: UserStatusAction;
  fromStatus: UserStatus;
  toStatus: UserStatus;
  actorUserId: string;
  reason?: string;
  changedAt: string;
};

export type CustomerStatusChangeResult = {
  customerId: string;
  status: UserStatus;
  /** false when the Customer was already in the requested state (idempotent repeat). */
  changed: boolean;
  change?: CustomerStatusChangeDto;
};

/** Statuses a suspension can start from; reactivation restores the one recorded at suspension. */
const suspendableStatuses: readonly UserStatus[] = ["ACTIVE", "DORMANT"];

export const toCustomerStatusChangeDto = (
  entry: UserStatusHistoryEntry,
): CustomerStatusChangeDto => ({
  action: entry.action,
  fromStatus: entry.fromStatus,
  toStatus: entry.toStatus,
  actorUserId: String(entry.actorUserId),
  ...(entry.reason ? { reason: entry.reason } : {}),
  changedAt: entry.changedAt.toISOString(),
});

/**
 * P2.2.6 — Super Admin suspends / reactivates a platform Customer account.
 *
 * - Only CUSTOMER targets (anything else is the same 404 as an unknown id). DELETED is terminal (409).
 * - The status change and its audit entry are one atomic compare-and-set on the status that was
 *   read, so two admins acting at once can never both apply or interleave a stale transition.
 * - Repeating an action that already holds returns `changed: false` with no new audit row.
 * - Status, audit and session revocation commit together in the repository transaction.
 *   Repeats reconcile legacy suspended accounts without appending duplicate history.
 * - Bookings, payments, refunds, ledger rows and saved cards are never read for change or
 *   modified; system-side processing (webhooks, workers, refunds) keeps running.
 */
export class SuperAdminCustomerStatusService {
  public constructor(
    private readonly userRepository: Pick<
      UserRepository,
      "findById" | "transitionCustomerStatus" | "ensureCustomerSessionsRevoked"
    >,
  ) {}

  public suspend(
    actor: CustomerStatusActor,
    customerId: string,
    input: { reason?: string | undefined; requestId?: string | undefined } = {},
  ): Promise<CustomerStatusChangeResult> {
    return this.change("SUSPEND", actor, customerId, input);
  }

  public reactivate(
    actor: CustomerStatusActor,
    customerId: string,
    input: { reason?: string | undefined; requestId?: string | undefined } = {},
  ): Promise<CustomerStatusChangeResult> {
    return this.change("REACTIVATE", actor, customerId, input);
  }

  private async change(
    action: UserStatusAction,
    actor: CustomerStatusActor,
    customerId: string,
    input: { reason?: string | undefined; requestId?: string | undefined },
  ): Promise<CustomerStatusChangeResult> {
    if (actor.role !== "SUPER_ADMIN") throw new SuperAdminError("SUPER_ADMIN_FORBIDDEN", 403);

    const user = await this.requireCustomer(customerId);
    if (this.alreadyApplied(action, user.status)) {
      if (action === "SUSPEND") {
        let confirmed: boolean;
        try {
          confirmed = await this.userRepository.ensureCustomerSessionsRevoked(user._id);
        } catch {
          throw new SuperAdminError("SUPER_ADMIN_CUSTOMER_STATUS_UNCONFIRMED", 503);
        }
        if (!confirmed) {
          const current = await this.requireCustomer(customerId);
          throw new SuperAdminError("SUPER_ADMIN_CUSTOMER_STATUS_CONFLICT", 409, [
            {
              message:
                "This customer's status changed during session reconciliation. Refresh and try again.",
              code: `CURRENT_STATUS_${current.status}`,
            },
          ]);
        }
      }
      return this.unchanged(user);
    }

    const toStatus = action === "SUSPEND" ? "SUSPENDED" : this.restoredStatus(user);
    const reason = input.reason?.trim();
    const entry: UserStatusHistoryEntry = {
      action,
      fromStatus: user.status,
      toStatus,
      actorUserId: new Types.ObjectId(actor.userId),
      actorRole: actor.role,
      ...(reason ? { reason } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      changedAt: new Date(),
    };

    let updated: UserDocument | null;
    try {
      updated = await this.userRepository.transitionCustomerStatus(user._id, user.status, entry);
    } catch (error) {
      logger.error({ err: error, customerId, action }, "Customer status transaction unconfirmed");
      throw new SuperAdminError("SUPER_ADMIN_CUSTOMER_STATUS_UNCONFIRMED", 503);
    }
    if (!updated) {
      // Lost the compare-and-set: someone changed the account between our read and write.
      const current = await this.requireCustomer(customerId);
      if (this.alreadyApplied(action, current.status)) return this.unchanged(current);
      throw new SuperAdminError("SUPER_ADMIN_CUSTOMER_STATUS_CONFLICT", 409, [
        {
          message: "This customer's status was changed by someone else. Refresh and try again.",
          code: `CURRENT_STATUS_${current.status}`,
        },
      ]);
    }

    logger.info(
      {
        event: "super_admin.customer_status_changed",
        action,
        customerId: String(updated._id),
        actorUserId: actor.userId,
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        requestId: input.requestId,
      },
      "Customer account status changed by Super Admin",
    );

    return {
      customerId: String(updated._id),
      status: updated.status,
      changed: true,
      change: toCustomerStatusChangeDto(entry),
    };
  }

  private async requireCustomer(customerId: string): Promise<UserDocument> {
    const user = Types.ObjectId.isValid(customerId)
      ? await this.userRepository.findById(customerId)
      : null;
    if (user?.role !== "CUSTOMER") {
      throw new SuperAdminError("SUPER_ADMIN_CUSTOMER_NOT_FOUND", 404);
    }
    if (user.status === "DELETED") {
      throw new SuperAdminError("SUPER_ADMIN_CUSTOMER_DELETED", 409);
    }
    return user;
  }

  private alreadyApplied(action: UserStatusAction, status: UserStatus): boolean {
    return action === "SUSPEND" ? status === "SUSPENDED" : status !== "SUSPENDED";
  }

  /** The status in force before the latest suspension (ACTIVE when unknown, e.g. legacy rows). */
  private restoredStatus(user: UserDocument): UserStatus {
    const history = user.statusHistory ?? [];
    for (let index = history.length - 1; index >= 0; index--) {
      const entry = history[index];
      if (entry?.action === "SUSPEND") {
        return suspendableStatuses.includes(entry.fromStatus) ? entry.fromStatus : "ACTIVE";
      }
    }
    return "ACTIVE";
  }

  private unchanged(user: UserDocument): CustomerStatusChangeResult {
    return { customerId: String(user._id), status: user.status, changed: false };
  }
}
