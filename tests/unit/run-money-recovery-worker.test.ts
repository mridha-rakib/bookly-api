import { describe, expect, it, vi } from "vitest";

import { logger } from "../../src/config/logger.js";
import type { MoneyRecoveryService } from "../../src/modules/payment/money-recovery.service.js";
import { runContinuous, runOnce } from "../../src/scripts/run-money-recovery-worker.js";

vi.mock("../../src/config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("money recovery runner", () => {
  it("runs continuous passes single-flight", async () => {
    let stopping = false;
    let active = 0;
    let maximumActive = 0;
    const service = {
      runOnce: vi.fn(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return {
          paymentAttempts: 0,
          refundOperations: 0,
          webhooksProcessed: 0,
          webhooksFailed: 0,
          errors: 0,
        };
      }),
    } as unknown as MoneyRecoveryService;

    await runContinuous(
      service,
      () => stopping,
      async () => {
        stopping = true;
      },
    );

    expect(service.runOnce).toHaveBeenCalledOnce();
    expect(maximumActive).toBe(1);
  });

  it("does not finish shutdown until the active pass finishes", async () => {
    let stopping = false;
    let releasePass: (() => void) | undefined;
    let finished = false;
    const service = {
      runOnce: vi.fn(
        () =>
          new Promise((resolve) => {
            releasePass = () =>
              resolve({
                paymentAttempts: 0,
                refundOperations: 0,
                webhooksProcessed: 0,
                webhooksFailed: 0,
                errors: 0,
              });
          }),
      ),
    } as unknown as MoneyRecoveryService;

    const running = runContinuous(
      service,
      () => stopping,
      async () => undefined,
    ).then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(releasePass).toBeTypeOf("function"));
    stopping = true;
    await Promise.resolve();
    expect(finished).toBe(false);
    releasePass?.();
    await running;
    expect(finished).toBe(true);
  });

  it("runOnce executes exactly one service pass", async () => {
    const service = {
      runOnce: vi.fn(async () => ({
        paymentAttempts: 0,
        refundOperations: 0,
        webhooksProcessed: 0,
        webhooksFailed: 0,
        errors: 0,
      })),
    } as unknown as MoneyRecoveryService;
    await runOnce(service);
    expect(service.runOnce).toHaveBeenCalledOnce();
  });

  it("retries a failed pass serially after 30 seconds without logging raw errors", async () => {
    vi.clearAllMocks();
    let stopping = false;
    let waits = 0;
    const service = {
      runOnce: vi
        .fn()
        .mockRejectedValueOnce(new Error("synthetic-private-provider-payload"))
        .mockResolvedValue({ errors: 0, webhooksFailed: 0 }),
    } as unknown as MoneyRecoveryService;
    await runContinuous(
      service,
      () => stopping,
      async (milliseconds) => {
        expect(milliseconds).toBe(30_000);
        waits += 1;
        if (waits === 2) stopping = true;
      },
    );
    expect(service.runOnce).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      { event: "MONEY_RECOVERY_PASS_FAILED" },
      "Money recovery worker pass failed",
    );
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("synthetic-private");
  });

  it("makes partial pass failures visible without calling them successful recovery", async () => {
    vi.clearAllMocks();
    const counts = { paymentAttempts: 1, errors: 1, webhooksFailed: 0 };
    const service = { runOnce: vi.fn(async () => counts) } as unknown as MoneyRecoveryService;
    await runOnce(service);
    expect(logger.warn).toHaveBeenCalledWith(
      { counts },
      "Money recovery worker pass completed with unresolved errors",
    );
    expect(logger.info).not.toHaveBeenCalled();
  });
});
