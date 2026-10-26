import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import {
  assertMoneyRecoveryLaunch,
  MoneyRecoveryLaunchError,
  withMoneyRecoveryLifecycle,
} from "../../src/scripts/money-recovery-runtime.js";

const launchEnvironment = {
  BOOKLY_MONEY_RECOVERY_WORKER_ENABLED: "true",
  BOOKLY_MONEY_RECOVERY_SINGLE_WORKER_CONFIRMED: "true",
  MONGODB_URI: "mongodb://127.0.0.1:27017/synthetic_worker",
  STRIPE_SECRET_KEY: "synthetic-not-used-by-this-test",
};

describe("money recovery launch boundary", () => {
  it.each([{ args: [] }, { args: ["--once"] }])(
    "accepts explicit single-worker launch %j",
    ({ args }) => {
      expect(() => assertMoneyRecoveryLaunch(launchEnvironment, args)).not.toThrow();
    },
  );

  it.each([
    ["BOOKLY_MONEY_RECOVERY_WORKER_ENABLED", undefined],
    ["BOOKLY_MONEY_RECOVERY_WORKER_ENABLED", "false"],
    ["BOOKLY_MONEY_RECOVERY_WORKER_ENABLED", "TRUE"],
    ["BOOKLY_MONEY_RECOVERY_SINGLE_WORKER_CONFIRMED", undefined],
    ["BOOKLY_MONEY_RECOVERY_SINGLE_WORKER_CONFIRMED", "false"],
    ["NODE_APP_INSTANCE", "1"],
    ["NODE_APP_INSTANCE", "malformed"],
    ["NODE_UNIQUE_ID", "0"],
    ["MONGODB_URI", undefined],
    ["MONGODB_URI", " "],
    ["STRIPE_SECRET_KEY", undefined],
    ["STRIPE_SECRET_KEY", " "],
  ] as const)("refuses incomplete or unsupported launch: %s=%s", (key, value) => {
    expect(() => assertMoneyRecoveryLaunch({ ...launchEnvironment, [key]: value }, [])).toThrow(
      MoneyRecoveryLaunchError,
    );
  });

  it("accepts PM2's first fork but does not claim to enforce a distributed singleton", () => {
    expect(() =>
      assertMoneyRecoveryLaunch({ ...launchEnvironment, NODE_APP_INSTANCE: "0" }, []),
    ).not.toThrow();
    // Two separate hosts can both declare the same topology. This is an acknowledgement,
    // not a database lease; deployment must prevent the second process.
    expect(() => assertMoneyRecoveryLaunch(launchEnvironment, [])).not.toThrow();
  });

  it("rejects misspelled/repeated CLI options instead of accidentally polling forever", () => {
    expect(() => assertMoneyRecoveryLaunch(launchEnvironment, ["--ones"])).toThrow();
    expect(() => assertMoneyRecoveryLaunch(launchEnvironment, ["--once", "--once"])).toThrow();
  });

  it("does not echo supplied values in a launch error", () => {
    expect(() =>
      assertMoneyRecoveryLaunch({ ...launchEnvironment, NODE_APP_INSTANCE: "private-value" }, []),
    ).toThrow("Money recovery does not support additional process instances");
  });
});

describe("money recovery process lifecycle", () => {
  it("handles stop during connection without starting a financial pass", async () => {
    const signals = new EventEmitter();
    const connected = Promise.withResolvers<void>();
    const events: string[] = [];
    const running = withMoneyRecoveryLifecycle({
      signals,
      connect: () => connected.promise,
      disconnect: async () => {
        events.push("disconnected");
      },
      execute: async () => {
        events.push("executed");
      },
      onStopping: () => {
        events.push("stopping");
      },
    });
    signals.emit("SIGTERM");
    connected.resolve();
    await running;
    expect(events).toEqual(["stopping", "disconnected"]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("drains the active pass before disconnecting", async () => {
    const signals = new EventEmitter();
    const active = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    const running = withMoneyRecoveryLifecycle({
      signals,
      connect: async () => undefined,
      disconnect: async () => {
        events.push("disconnected");
      },
      execute: async (shouldStop) => {
        active.resolve();
        await release.promise;
        expect(shouldStop()).toBe(true);
        events.push("pass-finished");
      },
      onStopping: () => {
        events.push("stopping");
      },
    });
    await active.promise;
    signals.emit("SIGINT");
    await Promise.resolve();
    expect(events).toEqual(["stopping"]);
    release.resolve();
    await running;
    expect(events).toEqual(["stopping", "pass-finished", "disconnected"]);
  });

  it("interrupts the polling wait on stop", async () => {
    const signals = new EventEmitter();
    const waiting = Promise.withResolvers<void>();
    let disconnected = false;
    const running = withMoneyRecoveryLifecycle({
      signals,
      connect: async () => undefined,
      disconnect: async () => {
        disconnected = true;
      },
      execute: async (shouldStop, wait) => {
        const pending = wait(30_000);
        waiting.resolve();
        await pending;
        expect(shouldStop()).toBe(true);
      },
      onStopping: () => undefined,
    });
    await waiting.promise;
    signals.emit("SIGTERM");
    await running;
    expect(disconnected).toBe(true);
  });

  it.each(["connect", "execute", "disconnect"])("cleans listeners on %s failure", async (phase) => {
    const signals = new EventEmitter();
    const events: string[] = [];
    const running = withMoneyRecoveryLifecycle({
      signals,
      connect: async () => {
        if (phase === "connect") throw new Error(phase);
      },
      disconnect: async () => {
        events.push("disconnect");
        if (phase === "disconnect") throw new Error(phase);
      },
      execute: async () => {
        if (phase === "execute") throw new Error(phase);
      },
      onStopping: () => undefined,
    });
    await expect(running).rejects.toThrow(phase);
    expect(events).toEqual(["disconnect"]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});
