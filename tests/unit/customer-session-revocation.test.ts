import { type ClientSession, Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthError } from "../../src/modules/auth/auth.errors.js";
import { issueAuthSession } from "../../src/modules/auth/auth-session.js";
import { TokenService } from "../../src/modules/auth/token.service.js";
import { SessionModel } from "../../src/modules/session/session.model.js";
import { SessionRepository } from "../../src/modules/session/session.repository.js";
import { SuperAdminCustomerStatusService } from "../../src/modules/super-admin/super-admin-customer-status.service.js";
import {
  type UserDocument,
  UserModel,
  type UserStatusHistoryEntry,
} from "../../src/modules/user/user.model.js";
import { UserRepository } from "../../src/modules/user/user.repository.js";

const customerId = new Types.ObjectId();
const actor = { userId: String(new Types.ObjectId()), role: "SUPER_ADMIN" as const };
const transaction = {} as ClientSession;
const entry: UserStatusHistoryEntry = {
  action: "SUSPEND",
  fromStatus: "ACTIVE",
  toStatus: "SUSPENDED",
  actorUserId: new Types.ObjectId(actor.userId),
  actorRole: "SUPER_ADMIN",
  changedAt: new Date(),
};
let user: UserDocument;
let revoked: boolean;
let failRevocation: boolean;

// Models transaction commit/rollback only; no database or driver is started.
beforeEach(() => {
  user = {
    _id: customerId,
    role: "CUSTOMER",
    status: "ACTIVE",
    statusHistory: [],
  } as unknown as UserDocument;
  revoked = false;
  failRevocation = false;
  vi.spyOn(UserModel.db, "transaction").mockImplementation((async (
    callback: (session: ClientSession) => Promise<unknown>,
  ) => {
    const snapshot = { ...user, statusHistory: [...(user.statusHistory ?? [])] };
    const before = revoked;
    try {
      return await callback(transaction);
    } catch (error) {
      user = snapshot;
      revoked = before;
      throw error;
    }
  }) as never);
  vi.spyOn(UserRepository.prototype, "findById").mockImplementation(async () => ({ ...user }));
  vi.spyOn(UserModel, "findOneAndUpdate").mockImplementation(((
    filter: Record<string, unknown>,
    update: {
      $set?: { status: UserDocument["status"] };
      $push?: { statusHistory: UserStatusHistoryEntry };
    },
  ) => ({
    exec: async () => {
      const matches =
        typeof filter["status"] === "string"
          ? user.status === filter["status"]
          : !["SUSPENDED", "DELETED"].includes(user.status);
      if (!matches) return null;
      if (update.$set) user.status = update.$set.status;
      if (update.$push) user.statusHistory?.push(update.$push.statusHistory);
      return { ...user };
    },
  })) as never);
  vi.spyOn(UserModel, "findById").mockImplementation((() => ({
    session: () => ({ exec: async () => user }),
    read: () => ({ exec: async () => user }),
  })) as never);
  vi.spyOn(SessionModel, "updateMany").mockImplementation((async () => {
    if (failRevocation) throw new Error("storage unavailable");
    revoked = true;
    return { acknowledged: true, modifiedCount: 4 };
  }) as never);
});
afterEach(() => vi.restoreAllMocks());

describe("P2.2.6.1 atomic suspension and session write guards", () => {
  it("commits status, audit and every target session (including consumed ancestors) in one transaction", async () => {
    const result = await new SuperAdminCustomerStatusService(new UserRepository()).suspend(
      actor,
      String(customerId),
    );
    expect(result.changed).toBe(true);
    expect(user.status).toBe("SUSPENDED");
    expect(user.statusHistory).toHaveLength(1);
    expect(revoked).toBe(true);
    expect(SessionModel.updateMany).toHaveBeenCalledWith(
      { userId: customerId },
      {
        $set: { revokedAt: expect.any(Date), revocationReason: "ADMIN_SUSPENSION" },
        $inc: { revocationVersion: 1 },
      },
      { session: transaction },
    );
  });

  it("rolls back a failed revocation, reports unconfirmed, and retries without duplicate history", async () => {
    const service = new SuperAdminCustomerStatusService(new UserRepository());
    failRevocation = true;
    await expect(service.suspend(actor, String(customerId))).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(user.status).toBe("ACTIVE");
    expect(user.statusHistory).toHaveLength(0);
    expect(revoked).toBe(false);
    failRevocation = false;
    await expect(service.suspend(actor, String(customerId))).resolves.toMatchObject({
      changed: true,
    });
    await expect(service.suspend(actor, String(customerId))).resolves.toMatchObject({
      changed: false,
    });
    expect(user.statusHistory).toHaveLength(1);
    expect(revoked).toBe(true);
  });

  it("retries missing revocation for an already suspended legacy account without audit duplication", async () => {
    user.status = "SUSPENDED";
    const service = new SuperAdminCustomerStatusService(new UserRepository());
    failRevocation = true;
    await expect(service.suspend(actor, String(customerId))).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(user.status).toBe("SUSPENDED");
    failRevocation = false;
    await expect(service.suspend(actor, String(customerId))).resolves.toMatchObject({
      changed: false,
    });
    expect(revoked).toBe(true);
    expect(user.statusHistory).toHaveLength(0);
  });

  it("reactivation reconciles legacy sessions before unlocking, and rolls back on failure", async () => {
    user.status = "SUSPENDED";
    failRevocation = true;
    const service = new SuperAdminCustomerStatusService(new UserRepository());
    await expect(service.reactivate(actor, String(customerId))).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(user.status).toBe("SUSPENDED");
    failRevocation = false;
    await service.reactivate(actor, String(customerId));
    expect(user.status).toBe("ACTIVE");
    expect(revoked).toBe(true);
  });

  it("a lost compare-and-set writes neither revocation nor history", async () => {
    user.status = "DORMANT";
    await expect(
      new UserRepository().transitionCustomerStatus(customerId, "ACTIVE", entry),
    ).resolves.toBeNull();
    expect(revoked).toBe(false);
    expect(user.statusHistory).toHaveLength(0);
  });

  it.each(["PASSWORD", "GOOGLE", "FACEBOOK", "APPLE"])(
    "%s issuance racing behind suspension cannot insert a session",
    async () => {
      user.status = "SUSPENDED";
      const save = vi.spyOn(SessionModel.prototype, "save").mockResolvedValue({} as never);
      const tokens = new TokenService(new SessionRepository());
      await expect(
        issueAuthSession(
          tokens,
          {
            userId: customerId,
            email: "c@example.test",
            role: "CUSTOMER",
            status: "ACTIVE",
          },
          {},
        ),
      ).rejects.toMatchObject({ statusCode: 403, details: [{ code: "USER_SUSPENDED" }] });
      expect(save).not.toHaveBeenCalled();
    },
  );

  it("a new complete sign-in after reactivation inserts a new family under the User write guard", async () => {
    const save = vi.spyOn(SessionModel.prototype, "save").mockResolvedValue({} as never);
    const result = await issueAuthSession(
      new TokenService(new SessionRepository()),
      {
        userId: customerId,
        email: "c@example.test",
        role: "CUSTOMER",
        status: "ACTIVE",
      },
      {},
    );
    expect(result.accessToken).toBeTruthy();
    expect(save).toHaveBeenCalledWith({ session: transaction });
    expect(UserModel.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: customerId,
        status: { $nin: ["SUSPENDED", "DELETED"] },
        $or: [{ twoFactorEnabled: { $ne: true } }],
      },
      { $inc: { authSessionVersion: 1 } },
      { session: transaction, new: true },
    );
  });

  it("rotation racing behind suspension returns restriction before consuming or inserting", async () => {
    user.status = "SUSPENDED";
    const create = vi.spyOn(SessionRepository.prototype, "create");
    await expect(
      new SessionRepository().rotate({ userId: customerId } as never, "hash", new Date()),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["ADMIN_SUSPENSION", "LOGOUT", "REVOKE_ALL"] as const)(
    "rotation losing to %s after reactivation reports expiry rather than theft",
    async (reason) => {
      vi.mocked(UserModel.findOneAndUpdate).mockReturnValue({ exec: async () => user } as never);
      vi.spyOn(SessionModel, "findOneAndUpdate").mockReturnValue({
        exec: async () => null,
      } as never);
      vi.spyOn(SessionModel, "findById").mockReturnValue({
        session: () => ({ exec: async () => ({ revocationReason: reason }) }),
      } as never);
      await expect(
        new SessionRepository().rotate({ userId: customerId } as never, "hash", new Date()),
      ).rejects.toThrow("SESSION_EXPIRED");
    },
  );

  it("administrative revocation returns restriction while suspended, expiry after reactivation", async () => {
    const repository = new SessionRepository();
    user.status = "SUSPENDED";
    expect(await repository.administrativeRevocationError(customerId)).toMatchObject({
      statusCode: 403,
    });
    user.status = "ACTIVE";
    expect(await repository.administrativeRevocationError(customerId)).toMatchObject({
      statusCode: 401,
    });
  });

  it("a genuine concurrent replay still revokes the winning family", async () => {
    const repo = {
      findByRefreshTokenHash: vi.fn().mockResolvedValue({
        userId: customerId,
        tokenFamilyId: "f",
        expiresAt: new Date(Date.now() + 60_000),
      }),
      rotate: vi.fn().mockRejectedValue(new Error("REFRESH_TOKEN_REUSED")),
      revokeFamily: vi.fn(),
    };
    await expect(new TokenService(repo as never).rotateRefreshToken("old")).rejects.toThrow(
      "REFRESH_TOKEN_REUSED",
    );
    expect(repo.revokeFamily).toHaveBeenCalledWith("f");
  });

  it("refresh of an administrative credential never enters the replay path", async () => {
    const repo = {
      findByRefreshTokenHash: vi.fn().mockResolvedValue({
        userId: customerId,
        tokenFamilyId: "f",
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(),
        revocationReason: "ADMIN_SUSPENSION",
      }),
      administrativeRevocationError: vi
        .fn()
        .mockResolvedValue(new AuthError("USER_SUSPENDED", 403)),
      rotate: vi.fn(),
      revokeFamily: vi.fn(),
    };
    const tokens = new TokenService(repo as never);
    await expect(tokens.rotateRefreshToken("old")).rejects.toMatchObject({ statusCode: 403 });
    repo.administrativeRevocationError.mockResolvedValue(new AuthError("SESSION_EXPIRED", 401));
    await expect(tokens.rotateRefreshToken("old")).rejects.toMatchObject({ statusCode: 401 });
    expect(repo.rotate).not.toHaveBeenCalled();
    expect(repo.revokeFamily).not.toHaveBeenCalled();
  });
});

it("a repeat suspend racing with reactivation reports conflict instead of stale success", async () => {
  user.status = "SUSPENDED";
  vi.spyOn(UserRepository.prototype, "ensureCustomerSessionsRevoked").mockImplementation(
    async () => {
      user.status = "ACTIVE";
      return false;
    },
  );
  await expect(
    new SuperAdminCustomerStatusService(new UserRepository()).suspend(actor, String(customerId)),
  ).rejects.toMatchObject({
    statusCode: 409,
    details: [expect.objectContaining({ code: "CURRENT_STATUS_ACTIVE" })],
  });
});
