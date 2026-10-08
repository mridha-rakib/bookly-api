import { describe, expect, it, vi } from "vitest";

import type { MoneyRecoveryService } from "../../src/modules/payment/money-recovery.service.js";
import { runContinuous, runOnce } from "../../src/scripts/run-money-recovery-worker.js";

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
});
