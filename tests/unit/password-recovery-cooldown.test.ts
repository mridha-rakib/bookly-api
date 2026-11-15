import { beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({
  findUser: vi.fn(),
  update: vi.fn(),
  issue: vi.fn(),
  exists: vi.fn(),
  send: vi.fn(),
}));
vi.mock("../../src/modules/user/user.model.js", () => ({ UserModel: { findOne: fx.findUser } }));
vi.mock("../../src/modules/auth/password-recovery.model.js", () => ({
  PasswordRecoveryModel: { updateOne: fx.update, findOneAndUpdate: fx.issue, exists: fx.exists },
}));

import { PasswordRecoveryService } from "../../src/modules/auth/password-recovery.service.js";
import type { SessionRepository } from "../../src/modules/session/session.repository.js";

const service = new PasswordRecoveryService(
  { sendOtp: fx.send, sendNotice: vi.fn() },
  { hash: vi.fn(), verify: vi.fn() },
  {} as SessionRepository,
);
const previous = "x".repeat(64);
beforeEach(() => {
  vi.clearAllMocks();
  fx.findUser.mockReturnValue({ select: () => ({ lean: () => ({ exec: async () => null }) }) });
  fx.update.mockResolvedValue({});
  fx.issue.mockReturnValue({ exec: async () => null });
});
describe("password recovery repeated request", () => {
  it("restores only an active matching challenge on cooldown", async () => {
    fx.exists.mockResolvedValue({ _id: "matched" });
    const result = await service.request("CUSTOMER", "synthetic@example.test", previous);
    expect(result.challenge).toBe(previous);
    expect(fx.exists).toHaveBeenCalledWith(
      expect.objectContaining({
        portal: "CUSTOMER",
        challengeHash: expect.any(String),
        expiresAt: expect.any(Object),
        attempts: expect.any(Object),
      }),
    );
    expect(fx.send).not.toHaveBeenCalled();
  });
  it("returns no usable challenge for a fresh or stale tab during cooldown", async () => {
    fx.exists.mockResolvedValue(null);
    expect((await service.request("CUSTOMER", "synthetic@example.test")).challenge).toBe("");
    expect((await service.request("CUSTOMER", "synthetic@example.test", previous)).challenge).toBe(
      "",
    );
  });
  it("returns a newly issued challenge when request is allowed", async () => {
    fx.issue.mockReturnValue({ exec: async () => ({ _id: "issued" }) });
    expect(
      (await service.request("CUSTOMER", "synthetic@example.test", previous)).challenge,
    ).not.toBe(previous);
    expect(fx.exists).not.toHaveBeenCalled();
  });
});
