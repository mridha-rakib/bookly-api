import { EventEmitter } from "node:events";
import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";

import { logger } from "../../src/config/logger.js";
import { NoShowResolutionService } from "../../src/modules/booking/no-show-resolution.service.js";
import {
  runContinuous,
  runNoShowWorkerLifecycle,
  runOnce,
} from "../../src/scripts/run-no-show-worker.js";

vi.mock("../../src/config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const result = (error = 0) => ({
  charged: 0,
  charge_failed: 0,
  charge_pending: 0,
  waived_no_policy: 0,
  waived_no_charge_possible: 0,
  skipped_already_resolved: 0,
  error,
});

const worker = (run: () => Promise<ReturnType<typeof result>>) =>
  ({ runOnce: vi.fn(run) }) as unknown as NoShowResolutionService;

const lifecycle = (overrides: Partial<Parameters<typeof runNoShowWorkerLifecycle>[0]> = {}) => {
  const signals = new EventEmitter();
  const events: string[] = [];
  const disconnect = vi.fn(async () => {
    events.push("disconnect");
  });
  const options: Parameters<typeof runNoShowWorkerLifecycle>[0] = {
    service: worker(async () => result()),
    runForever: true,
    signals: signals as unknown as NodeJS.Process,
    connect: async () => {
      events.push("connect");
    },
    disconnect,
    batchSize: 7,
    pollIntervalMs: 11,
    shutdownTimeoutMs: 100,
    onShutdownTimeout: vi.fn(),
    ...overrides,
  };
  return { signals, events, disconnect, options };
};

describe("no-show worker runner", () => {
  it("does not overlap a long-running pass and waits a full interval after it settles", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let active = 0;
    let maximumActive = 0;
    let stopping = false;
    const service = worker(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      started.resolve();
      await release.promise;
      active -= 1;
      return result();
    });
    const waits: number[] = [];
    const running = runContinuous(
      service,
      () => stopping,
      async (milliseconds) => {
        waits.push(milliseconds);
        stopping = true;
      },
      7,
      11,
    );
    await started.promise;
    expect(service.runOnce).toHaveBeenCalledOnce();
    expect(maximumActive).toBe(1);
    release.resolve();
    await running;
    expect(maximumActive).toBe(1);
    expect(waits).toEqual([11]);
    expect(service.runOnce).toHaveBeenCalledOnce();
    expect(service.runOnce).toHaveBeenCalledWith(7, expect.any(Function));
  });

  it.each(["SIGTERM", "SIGINT"] as const)(
    "%s stops new passes and disconnects only after the active pass settles",
    async (signal) => {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const events: string[] = [];
      const service = worker(async () => {
        events.push("pass-start");
        started.resolve();
        await release.promise;
        events.push("pass-end");
        return result();
      });
      const h = lifecycle({
        service,
        connect: async () => {
          events.push("connect");
        },
        disconnect: async () => {
          events.push("disconnect");
        },
      });
      const running = runNoShowWorkerLifecycle(h.options);
      await started.promise;
      h.signals.emit(signal);
      await Promise.resolve();
      expect(events).toEqual(["connect", "pass-start"]);
      expect(service.runOnce).toHaveBeenCalledOnce();
      release.resolve();
      await running;
      expect(events).toEqual(["connect", "pass-start", "pass-end", "disconnect"]);
      expect(service.runOnce).toHaveBeenCalledOnce();
      expect(h.signals.listenerCount("SIGINT")).toBe(0);
      expect(h.signals.listenerCount("SIGTERM")).toBe(0);
    },
  );

  it("treats repeated signals as one shutdown and drains before one disconnect", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    const service = worker(async () => {
      started.resolve();
      await release.promise;
      return result();
    });
    const onStopping = vi.spyOn(logger, "info");
    const h = lifecycle({
      service,
      connect: async () => undefined,
      disconnect: vi.fn(async () => {
        events.push("disconnect");
      }),
    });
    const running = runNoShowWorkerLifecycle(h.options);
    await started.promise;
    h.signals.emit("SIGTERM");
    h.signals.emit("SIGTERM");
    h.signals.emit("SIGINT");
    expect(h.disconnect).not.toHaveBeenCalled();
    release.resolve();
    await running;
    expect(h.options.disconnect).toHaveBeenCalledOnce();
    expect(events).toEqual(["disconnect"]);
    expect(onStopping).toHaveBeenCalledWith(
      "No-show worker stopping: no new candidate claims; draining the active item",
    );
  });

  it("keeps --once to one pass and disconnects afterward", async () => {
    const events: string[] = [];
    const service = worker(async () => {
      events.push("pass");
      return result();
    });
    const h = lifecycle({
      service,
      runForever: false,
      connect: async () => {
        events.push("connect");
      },
      disconnect: async () => {
        events.push("disconnect");
      },
    });
    await runNoShowWorkerLifecycle(h.options);
    expect(events).toEqual(["connect", "pass", "disconnect"]);
    expect(service.runOnce).toHaveBeenCalledOnce();
  });

  it("makes partial and thrown worker failures observable without hiding them as success", async () => {
    vi.clearAllMocks();
    const partial = worker(async () => result(1));
    await runOnce(partial, 7);
    expect(logger.warn).toHaveBeenCalledWith(
      { counts: result(1) },
      "No-show worker pass completed with unresolved item errors",
    );
    expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), "No-show worker pass complete");

    vi.clearAllMocks();
    let stopping = false;
    const failed = worker(async () => {
      throw new Error("synthetic no-show pass failure");
    });
    await runContinuous(
      failed,
      () => stopping,
      async () => {
        stopping = true;
      },
      7,
      11,
    );
    expect(logger.error).toHaveBeenCalledWith(
      { event: "NO_SHOW_WORKER_PASS_FAILED" },
      "No-show worker pass failed",
    );
    expect(failed.runOnce).toHaveBeenCalledOnce();
  });

  it("does not start work if shutdown arrives while the database is connecting", async () => {
    const connected = Promise.withResolvers<void>();
    const service = worker(async () => result());
    const h = lifecycle({ service, connect: () => connected.promise });
    const running = runNoShowWorkerLifecycle(h.options);
    h.signals.emit("SIGTERM");
    connected.resolve();
    await running;
    expect(service.runOnce).not.toHaveBeenCalled();
    expect(h.disconnect).toHaveBeenCalledOnce();
  });

  it("stops before claiming the next booking in an active candidate batch", async () => {
    let stopping = false;
    const bookingRepository = {
      findManyOverdueNoShows: vi
        .fn()
        .mockResolvedValue([
          { _id: new Types.ObjectId() },
          { _id: new Types.ObjectId() },
          { _id: new Types.ObjectId() },
        ]),
    };
    const service = new NoShowResolutionService(
      bookingRepository as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const autoResolve = vi.spyOn(service, "autoResolve").mockImplementation(async () => {
      stopping = true;
      return "waived_no_policy";
    });

    const counts = await service.runOnce(10, () => stopping);
    expect(autoResolve).toHaveBeenCalledOnce();
    expect(counts.waived_no_policy).toBe(1);
    expect(counts.skipped_already_resolved).toBe(0);
    expect(bookingRepository.findManyOverdueNoShows).toHaveBeenCalledOnce();
  });

  it("stops an in-progress candidate before the durable penalty claim if shutdown arrives during reads", async () => {
    let stopping = false;
    const bookingId = new Types.ObjectId();
    const bookingRepository = {
      findByIdOnly: vi.fn().mockResolvedValue({
        _id: bookingId,
        businessId: new Types.ObjectId(),
        status: "PENDING",
        noShowDeadlineAt: new Date(0),
        serviceLines: [],
        source: "BOOKLY_MANAGED",
        cancellationPolicySnapshot: { noShowPercentage: 20 },
        financials: { eligiblePlatformFeeBasisCents: 10_000 },
        customer: { customerUserId: new Types.ObjectId(), businessClientId: new Types.ObjectId() },
      }),
    };
    const financialTransactionService = {
      findSucceededUpfrontPayment: vi.fn(async () => {
        stopping = true;
        return undefined;
      }),
    };
    const penaltyCollection = { claimNoShowPenalty: vi.fn(), collect: vi.fn() };
    const service = new NoShowResolutionService(
      bookingRepository as never,
      {} as never,
      {} as never,
      financialTransactionService as never,
      undefined,
      undefined,
      penaltyCollection as never,
    );

    await expect(service.autoResolve(bookingId, () => stopping)).resolves.toBeUndefined();
    expect(financialTransactionService.findSucceededUpfrontPayment).toHaveBeenCalledOnce();
    expect(penaltyCollection.claimNoShowPenalty).not.toHaveBeenCalled();
    expect(penaltyCollection.collect).not.toHaveBeenCalled();
  });

  it("honors the configured shutdown grace before invoking the timeout exit", async () => {
    vi.useFakeTimers();
    try {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const onShutdownTimeout = vi.fn();
      const service = worker(async () => {
        started.resolve();
        await release.promise;
        return result();
      });
      const h = lifecycle({ service, shutdownTimeoutMs: 25, onShutdownTimeout });
      const running = runNoShowWorkerLifecycle(h.options);
      await started.promise;
      h.signals.emit("SIGTERM");
      await vi.advanceTimersByTimeAsync(24);
      expect(onShutdownTimeout).not.toHaveBeenCalled();
      expect(h.options.disconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onShutdownTimeout).toHaveBeenCalledOnce();
      expect(h.options.disconnect).not.toHaveBeenCalled();
      release.resolve();
      await running;
      expect(h.options.disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disconnects after a failed --once pass and preserves the rejection for nonzero exit", async () => {
    const service = worker(async () => {
      throw new Error("synthetic one-shot failure");
    });
    const h = lifecycle({ service, runForever: false });
    await expect(runNoShowWorkerLifecycle(h.options)).rejects.toThrow("synthetic one-shot failure");
    expect(service.runOnce).toHaveBeenCalledOnce();
    expect(h.options.disconnect).toHaveBeenCalledOnce();
  });
});
