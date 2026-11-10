import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrdinaryCalendarActivationProbes } from "../../src/modules/booking/ordinary-calendar-activation.js";

// P2.2.9.1 — activation readiness, fail-closed worker start, D1 journal persistence and
// operational configuration. No database, Google or worker process is used.
const gate = vi.hoisted(() => ({ delivery: false, creation: false }));
vi.mock("../../src/modules/booking/ordinary-calendar-journal-authority.js", () => ({
  ordinaryCalendarAuthoritativeModeAvailable: async () => gate.creation,
  verifyOrdinaryCalendarDeliveryAuthority: async () => {
    if (!gate.delivery) throw new Error("ORDINARY_CALENDAR_DELIVERY_UNAVAILABLE");
  },
}));

const activation = await import("../../src/modules/booking/ordinary-calendar-activation.js");
const journalModule = await import("../../src/modules/booking/ordinary-calendar-journal.js");
const { OrdinaryCalendarJournalModel } = await import(
  "../../src/modules/booking/ordinary-calendar-journal.model.js"
);
const { GoogleCalendarIntegrationModel } = await import(
  "../../src/modules/integration/integration.model.js"
);
const { OrdinaryCalendarWorker } = await import(
  "../../src/modules/booking/ordinary-calendar-worker.js"
);

const exact = [
  { name: "_id_", key: { _id: 1 } },
  { name: "bookingId_1", key: { bookingId: 1 }, unique: true },
  { name: "mode_1_state_1_nextAttemptAt_1", key: { mode: 1, state: 1, nextAttemptAt: 1 } },
];
const [idIndex, bookingIndex, dueIndex] = exact as [
  (typeof exact)[number],
  (typeof exact)[number],
  (typeof exact)[number],
];
const replicaSet = { setName: "atlas-abc", logicalSessionTimeoutMinutes: 30, maxWireVersion: 21 };
const goodProbes = (): OrdinaryCalendarActivationProbes => ({
  deliveryAuthority: async () => undefined,
  creationAuthority: async () => true,
  listIndexes: async () => exact,
  hello: async () => replicaSet,
  googleOAuthConfigured: () => true,
  tokenEncryptionKeyConfigured: () => true,
});

beforeEach(() => {
  gate.delivery = false;
  gate.creation = false;
});
afterEach(() => vi.restoreAllMocks());

describe("P2.2.9.1 journal index readiness", () => {
  it("recognizes the two exact indexes; unrelated extra indexes are fine", () => {
    expect(
      activation.diagnoseOrdinaryCalendarIndexes([...exact, { name: "x", key: { businessId: 1 } }]),
    ).toEqual({
      ready: true,
      missing: [],
      conflicting: [],
    });
  });

  it("reports missing indexes by name", () => {
    expect(activation.diagnoseOrdinaryCalendarIndexes([idIndex])).toEqual({
      ready: false,
      missing: ["bookingId_1", "mode_1_state_1_nextAttemptAt_1"],
      conflicting: [],
    });
  });

  it("reports conflicting lookalikes that would let duplicates through or skip rows", () => {
    const cases: Array<[object, string]> = [
      [{ name: "bookingId_1", key: { bookingId: 1 } }, "not unique"],
      [
        {
          name: "bookingId_1",
          key: { bookingId: 1 },
          unique: true,
          partialFilterExpression: { mode: "AUTHORITATIVE" },
        },
        "partial filter",
      ],
      [{ name: "bookingId_1", key: { bookingId: 1 }, unique: true, sparse: true }, "sparse"],
      [
        { name: "bookingId_1", key: { bookingId: 1 }, unique: true, collation: { locale: "en" } },
        "collation",
      ],
      [{ name: "bookingId_1", key: { bookingId: 1 }, unique: true, expireAfterSeconds: 60 }, "TTL"],
      [{ name: "bookingId_1", key: { bookingId: 1 }, unique: true, hidden: true }, "hidden"],
    ];
    for (const [index, problem] of cases) {
      const diagnosis = activation.diagnoseOrdinaryCalendarIndexes([idIndex, index, dueIndex]);
      expect(diagnosis.ready, problem).toBe(false);
      expect(diagnosis.conflicting).toEqual([{ name: "bookingId_1", problem }]);
    }
    expect(
      activation.diagnoseOrdinaryCalendarIndexes([
        bookingIndex,
        { name: "due", key: { mode: 1, state: 1, nextAttemptAt: 1 }, unique: true },
      ]).conflicting,
    ).toEqual([{ name: "due", problem: "unexpectedly unique" }]);
  });

  it("compound key order matters", () => {
    const reordered = { name: "wrong", key: { state: 1, mode: 1, nextAttemptAt: 1 } };
    expect(activation.diagnoseOrdinaryCalendarIndexes([bookingIndex, reordered]).missing).toEqual([
      "mode_1_state_1_nextAttemptAt_1",
    ]);
  });

  it("the Booking-side journal readiness uses the same strict rules (fails closed)", async () => {
    const partial = {
      name: "bookingId_1",
      key: { bookingId: 1 },
      unique: true,
      partialFilterExpression: { x: 1 },
    };
    expect(
      await new journalModule.OrdinaryCalendarJournalReadiness(async () => exact).isReady(),
    ).toBe(true);
    expect(
      await new journalModule.OrdinaryCalendarJournalReadiness(async () => [
        partial,
        dueIndex,
      ]).isReady(),
    ).toBe(false);
    expect(
      await new journalModule.OrdinaryCalendarJournalReadiness(async () => {
        throw new Error("ns not found");
      }).isReady(),
    ).toBe(false);
  });

  it("the worker launcher guard refuses missing, conflicting or unreadable indexes", async () => {
    await expect(
      activation.assertOrdinaryCalendarJournalProvisioned(async () => exact),
    ).resolves.toBeUndefined();
    for (const list of [
      async () => [bookingIndex],
      async () => [{ key: { bookingId: 1 } }, dueIndex],
      async () => {
        throw new Error("timeout");
      },
    ])
      await expect(activation.assertOrdinaryCalendarJournalProvisioned(list)).rejects.toThrow(
        "ORDINARY_CALENDAR_JOURNAL_NOT_PROVISIONED",
      );
  });
});

describe("P2.2.9.1 activation readiness report", () => {
  it("all automatic checks pass only when every probe passes; manual gates are always listed", async () => {
    const report = await activation.evaluateOrdinaryCalendarActivationReadiness(goodProbes());
    expect(report.automaticChecksPassed).toBe(true);
    expect(report.infrastructureReady).toBe(true);
    expect(report.manualGates).toContain("GOOGLE_SANDBOX_QUALIFICATION_RECORDED");
    expect(report.manualGates).toContain("OWNER_RATIFIED_D1_D2_D3_AND_RETRY_POLICY");
  });

  it("default-denied authorities are reported as denied, separately from infrastructure", async () => {
    const report = await activation.evaluateOrdinaryCalendarActivationReadiness({
      ...goodProbes(),
      deliveryAuthority: async () => {
        throw new Error("denied");
      },
      creationAuthority: async () => false,
    });
    expect(report.automaticChecksPassed).toBe(false);
    expect(report.infrastructureReady).toBe(true);
    expect(report.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([
      "DELIVERY_AUTHORITY",
      "CREATION_AUTHORITY",
    ]);
  });

  it("each missing infrastructure prerequisite fails closed — including probes that throw", async () => {
    const broken: Array<[string, Partial<ReturnType<typeof goodProbes>>]> = [
      ["JOURNAL_INDEXES", { listIndexes: async () => [idIndex] }],
      [
        "JOURNAL_INDEXES",
        {
          listIndexes: async () => {
            throw new Error("x");
          },
        },
      ],
      [
        "TRANSACTION_CAPABLE_DATABASE",
        {
          hello: async () => ({
            ismaster: true,
            maxWireVersion: 21,
            logicalSessionTimeoutMinutes: 30,
          }),
        },
      ],
      [
        "TRANSACTION_CAPABLE_DATABASE",
        {
          hello: async () => {
            throw new Error("x");
          },
        },
      ],
      ["GOOGLE_OAUTH_CONFIGURED", { googleOAuthConfigured: () => false }],
      [
        "GOOGLE_OAUTH_CONFIGURED",
        {
          googleOAuthConfigured: () => {
            throw new Error("x");
          },
        },
      ],
      ["TOKEN_ENCRYPTION_KEY_CONFIGURED", { tokenEncryptionKeyConfigured: () => false }],
    ];
    for (const [name, override] of broken) {
      const report = await activation.evaluateOrdinaryCalendarActivationReadiness({
        ...goodProbes(),
        ...override,
      });
      expect(report.infrastructureReady, name).toBe(false);
      expect(report.checks.find((check) => check.name === name)?.ok, name).toBe(false);
    }
  });

  it("transaction capability: replica set or mongos with sessions; standalone is refused", () => {
    expect(activation.isTransactionCapableTopology(replicaSet)).toBe(true);
    expect(
      activation.isTransactionCapableTopology({
        msg: "isdbgrid",
        logicalSessionTimeoutMinutes: 30,
        maxWireVersion: 8,
      }),
    ).toBe(true);
    expect(
      activation.isTransactionCapableTopology({
        msg: "isdbgrid",
        logicalSessionTimeoutMinutes: 30,
        maxWireVersion: 7,
      }),
    ).toBe(false);
    expect(
      activation.isTransactionCapableTopology({
        maxWireVersion: 21,
        logicalSessionTimeoutMinutes: 30,
      }),
    ).toBe(false);
    expect(activation.isTransactionCapableTopology({ setName: "rs", maxWireVersion: 21 })).toBe(
      false,
    );
  });

  it("the report carries no secret material", async () => {
    const report = await activation.evaluateOrdinaryCalendarActivationReadiness(goodProbes());
    expect(JSON.stringify(report)).not.toMatch(/mongodb(\+srv)?:\/\/|secret=|token=|atlas-abc/u);
  });
});

describe("P2.2.9.1 worker behaviour", () => {
  const row = () => ({ _id: new Types.ObjectId() });
  const repo = (due: Array<{ _id: Types.ObjectId }>) => ({
    listDue: vi.fn(async () => due),
    listIncidents: vi.fn(async () => []),
  });

  it("does nothing — not even a scan — while delivery authority is denied", async () => {
    const repository = repo([row()]);
    const dispatch = { deliver: vi.fn() };
    await expect(
      new OrdinaryCalendarWorker(dispatch, repository as never, { batchSize: 25 }).runOnce(),
    ).rejects.toThrow();
    expect(repository.listDue).not.toHaveBeenCalled();
    expect(dispatch.deliver).not.toHaveBeenCalled();
  });

  it("bounded serial batch; one failing row never stops the others", async () => {
    gate.delivery = true;
    const rows = [row(), row(), row()];
    const repository = repo(rows);
    let active = 0;
    let maxActive = 0;
    const dispatch = {
      deliver: vi.fn(async (id: Types.ObjectId) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        if (String(id) === String(rows[1]?._id)) throw new Error("boom");
        return "DONE" as const;
      }),
    };
    const counts = await new OrdinaryCalendarWorker(dispatch, repository as never, {
      batchSize: 3,
    }).runOnce();
    expect(repository.listDue).toHaveBeenCalledWith(3);
    expect(maxActive).toBe(1);
    expect(counts).toMatchObject({ scanned: 3, done: 2, failed: 1 });
  });

  it("a stop request leaves the rest durable and due (restart picks them up)", async () => {
    gate.delivery = true;
    const repository = repo([row(), row(), row()]);
    let stop = false;
    const dispatch = {
      deliver: vi.fn(async () => {
        stop = true;
        return "RETRY" as const;
      }),
    };
    const counts = await new OrdinaryCalendarWorker(dispatch, repository as never, {
      batchSize: 25,
    }).runOnce(() => stop);
    expect(dispatch.deliver).toHaveBeenCalledTimes(1);
    expect(counts).toMatchObject({ retry: 1, interrupted: 2 });
    expect(repository.listIncidents).not.toHaveBeenCalled();
  });

  it("reports retry-limit incidents for alerting", async () => {
    gate.delivery = true;
    const repository = {
      listDue: vi.fn(async () => []),
      listIncidents: vi.fn(async () => [
        {
          _id: new Types.ObjectId(),
          bookingId: new Types.ObjectId(),
          businessId: new Types.ObjectId(),
          mode: "AUTHORITATIVE",
          state: "BLOCKED_AUTHORITY",
          reason: "RETRY_LIMIT_REACHED",
        },
      ]),
    };
    const counts = await new OrdinaryCalendarWorker({ deliver: vi.fn() }, repository as never, {
      batchSize: 25,
    }).runOnce();
    expect(counts.incidents).toEqual({ PROVIDER_RETRY_LIMIT_REACHED: 1 });
  });
});

describe("P2.2.9.1 D1 — durable intent follows the Booking transaction", () => {
  const session = (inTransaction = true) => ({ inTransaction: () => inTransaction }) as never;
  const booking = (firstClass = false) =>
    ({
      _id: new Types.ObjectId(),
      businessId: new Types.ObjectId(),
      reference: "BK-1",
      status: "UPCOMING",
      serviceLines: [
        firstClass
          ? {
              pricingInput: { packageItemId: new Types.ObjectId() },
              packageContext: { role: "REDEMPTION" },
            }
          : { pricingInput: {} },
      ],
      schedule: {
        startAt: new Date("2026-01-15T08:00:00.000Z"),
        endAt: new Date("2026-01-15T09:00:00.000Z"),
        timezone: "Europe/Nicosia",
      },
      customer: { businessClientId: new Types.ObjectId() },
      eventHistory: [],
      rescheduleHistory: [],
    }) as never;
  const query = (value: unknown) => ({ session: () => ({ exec: async () => value }) });
  const ready = { isReady: async () => true };

  it("deployment default (authorities denied): nothing is read or written; the Booking stays legacy-owned", async () => {
    const find = vi.spyOn(OrdinaryCalendarJournalModel, "findOne");
    const create = vi.spyOn(OrdinaryCalendarJournalModel, "create");
    const journal = new journalModule.OrdinaryCalendarJournal(undefined, ready);
    expect(await journal.recordCreatedInTransaction(booking(), session())).toBeNull();
    expect(find).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("when reliable mode is active, a journal write failure aborts the Booking change (never a false durable success)", async () => {
    gate.delivery = true;
    gate.creation = true;
    vi.spyOn(OrdinaryCalendarJournalModel, "findOne").mockReturnValue(query(null) as never);
    vi.spyOn(GoogleCalendarIntegrationModel, "findOne").mockReturnValue(query(null) as never);
    vi.spyOn(OrdinaryCalendarJournalModel, "create").mockRejectedValue(
      new Error("WriteConflict") as never,
    );
    const journal = new journalModule.OrdinaryCalendarJournal(undefined, ready);
    await expect(journal.recordCreatedInTransaction(booking(), session())).rejects.toThrow(
      "WriteConflict",
    );
  });

  it("intent can only be recorded inside the Booking transaction", async () => {
    gate.delivery = true;
    gate.creation = true;
    const journal = new journalModule.OrdinaryCalendarJournal(undefined, ready);
    await expect(journal.recordCreatedInTransaction(booking(), session(false))).rejects.toThrow(
      "Calendar intent requires the Booking transaction",
    );
  });

  it("unprovisioned indexes keep the Booking legacy-owned even with both authorities granted", async () => {
    gate.delivery = true;
    gate.creation = true;
    const create = vi.spyOn(OrdinaryCalendarJournalModel, "create");
    const journal = new journalModule.OrdinaryCalendarJournal(undefined, {
      isReady: async () => false,
    });
    expect(await journal.recordCreatedInTransaction(booking(), session())).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("First-Class Bookings never get an ordinary journal row", async () => {
    gate.delivery = true;
    gate.creation = true;
    const find = vi.spyOn(OrdinaryCalendarJournalModel, "findOne");
    const journal = new journalModule.OrdinaryCalendarJournal(undefined, ready);
    expect(await journal.recordCreatedInTransaction(booking(true), session())).toBeNull();
    expect(find).not.toHaveBeenCalled();
  });
});

describe("P2.2.9.1 free-only operational configuration", () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

  it("the worker process file is opt-in, single-instance and drains longer than a lease", () => {
    const config = createRequire(import.meta.url)(
      "../../ecosystem.ordinary-calendar.config.cjs",
    ) as {
      apps: Array<{
        script: string;
        instances: number;
        exec_mode: string;
        kill_timeout: number;
        max_restarts: number;
      }>;
    };
    expect(config.apps).toHaveLength(1);
    expect(config.apps[0]).toMatchObject({
      script: "dist/scripts/run-ordinary-calendar-worker.js",
      instances: 1,
      exec_mode: "fork",
    });
    expect(config.apps[0]?.kill_timeout).toBeGreaterThan(45_000 + 10_000);
    expect(config.apps[0]?.max_restarts).toBeLessThanOrEqual(10);
    expect(read("ecosystem.config.cjs")).not.toContain("ordinary-calendar");
    expect(read("Dockerfile")).not.toContain("ordinary-calendar");
  });

  it("no paid queue, scheduler, cache or monitoring dependency is introduced", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const banned of [
      "bull",
      "bullmq",
      "ioredis",
      "redis",
      "agenda",
      "node-cron",
      "@upstash/qstash",
      "@sentry/node",
      "newrelic",
      "dd-trace",
    ])
      expect(names, banned).not.toContain(banned);
    expect(read("package.json")).toContain(
      '"calendar:readiness": "tsx src/scripts/run-ordinary-calendar-worker.ts --check"',
    );
  });
});

describe("P2.2.9.2 worker refusal is not a crash", () => {
  it("authority denial and an unprovisioned journal exit 78 (no restart); other failures exit 1", async () => {
    const { OrdinaryCalendarDeliveryUnavailableError } = await vi.importActual<
      typeof import("../../src/modules/booking/ordinary-calendar-journal-authority.js")
    >("../../src/modules/booking/ordinary-calendar-journal-authority.js");
    expect(
      activation.ordinaryCalendarWorkerStop(new OrdinaryCalendarDeliveryUnavailableError()),
    ).toEqual({
      exitCode: 78,
      refused: true,
      reason: "DELIVERY_AUTHORITY_DENIED",
    });
    expect(
      activation.ordinaryCalendarWorkerStop(new Error("ORDINARY_CALENDAR_JOURNAL_NOT_PROVISIONED")),
    ).toEqual({ exitCode: 78, refused: true, reason: "JOURNAL_NOT_PROVISIONED" });
    for (const failure of [
      new Error("connect ECONNREFUSED"),
      new Error("Ordinary Calendar worker pass failed"),
      "boom",
    ])
      expect(activation.ordinaryCalendarWorkerStop(failure)).toEqual({
        exitCode: 1,
        refused: false,
        reason: "FAILED",
      });
  });

  it("the shipped (default-denied) authority is classified as a refusal", async () => {
    const real = await vi.importActual<
      typeof import("../../src/modules/booking/ordinary-calendar-journal-authority.js")
    >("../../src/modules/booking/ordinary-calendar-journal-authority.js");
    const denial = await real.verifyOrdinaryCalendarDeliveryAuthority().then(
      () => null,
      (error: unknown) => error,
    );
    expect(activation.ordinaryCalendarWorkerStop(denial).refused).toBe(true);
    expect(await real.ordinaryCalendarAuthoritativeModeAvailable()).toBe(false);
  });

  it("PM2 never restarts a refused worker", () => {
    const config = createRequire(import.meta.url)(
      "../../ecosystem.ordinary-calendar.config.cjs",
    ) as {
      apps: Array<{ stop_exit_codes?: number[]; autorestart?: boolean }>;
    };
    expect(config.apps[0]?.stop_exit_codes).toEqual([
      activation.ORDINARY_CALENDAR_WORKER_REFUSED_EXIT_CODE,
    ]);
  });
});
