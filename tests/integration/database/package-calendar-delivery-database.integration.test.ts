import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import {
  BookingCreationClaimModel,
  claimBatchDeliveryTask,
} from "../../../src/modules/booking/booking-creation-claim.model.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import { PackageBatchDeliveryRecovery } from "../../../src/modules/booking/package-batch-delivery-recovery.js";
import { PackageBatchFinancialPersistence } from "../../../src/modules/booking/package-batch-financial-persistence.js";
import { PackageCalendarRepository } from "../../../src/modules/booking/package-calendar.repository.js";
import { PackageCalendarOwnerAuthority } from "../../../src/modules/booking/package-calendar-authority.js";
import {
  type CalendarDestination,
  type CalendarTaskReference,
  calendarBookingIntent,
  calendarJournalSchema,
} from "../../../src/modules/booking/package-calendar-contract.js";
import {
  PackageCalendarProviderError,
  PackageCalendarWriteAuthorityUnavailableError,
  packageCalendarEventId,
} from "../../../src/modules/booking/package-calendar-delivery.js";
import { PackageCalendarDispatch } from "../../../src/modules/booking/package-calendar-dispatch.js";
import { PackageLifecycleService } from "../../../src/modules/booking/package-lifecycle.service.js";
import { PackageLifecycleDeliveryRecovery } from "../../../src/modules/booking/package-lifecycle-delivery-recovery.js";
import { PackageLifecycleOperationModel } from "../../../src/modules/booking/package-lifecycle-operation.js";
import { BusinessClientModel } from "../../../src/modules/client/client.model.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { FinancialRelationshipRepository } from "../../../src/modules/client/financial-relationship.repository.js";
import { FinancialRelationshipService } from "../../../src/modules/client/financial-relationship.service.js";
import { IntegrationRepository } from "../../../src/modules/integration/integration.repository.js";
import { PackageProgressV2Model } from "../../../src/modules/package-progress/package-progress-v2.model.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { PaymentAttemptRepository } from "../../../src/modules/payment/payment-attempt.repository.js";
import { RefundOperationRepository } from "../../../src/modules/payment/refund-operation.repository.js";
import { UserModel } from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
import { fakePackageCalendar } from "../../helpers/fake-package-calendar.js";
import { FakePaymentGateway } from "../../helpers/fake-payment-gateway.js";
import { INTERNAL_TIME, packageBatchFixture } from "../../helpers/package-batch-fixture.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/**
 * P2C — the batch CREATED Calendar consumer with an explicitly injected (fake) delivery port.
 * Isolated disposable database; activation mocked ONLY for this engineering fixture (the shipped
 * gate still denies every call). No Google request is possible: the port is in-memory.
 */
vi.mock("../../../src/modules/booking/package-batch-authority.js", () => ({
  verifyPackageBatchActivation: vi.fn(async () => undefined),
}));
vi.mock("../../../src/modules/booking/package-purchase-authority.js", async (original) => ({
  ...(await original<object>()),
  verifyPackagePurchaseConsentCertification: vi.fn(async () => undefined),
}));
vi.mock("../../../src/modules/booking/package-calendar-authority.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/modules/booking/package-calendar-authority.js")
  >()),
  verifyPackageCalendarProductionAuthority: vi.fn(async () => undefined),
}));

const unusedReconcile = {
  reconcileExisting: vi.fn(async () => {
    throw new Error("reconcile-only port must not be used when delivery is injected");
  }),
};
const at = (ms: number) => () => new Date(INTERNAL_TIME.getTime() + ms);

/** A RETURNING (€0 online) purchase, either only internally materialized or completed. */
async function fixture(complete = true, releaseForTest = true) {
  const t = await packageBatchFixture({ bundlePriceCents: 0 });
  await BusinessClientModel.updateOne(
    { _id: t.scope.businessClientId },
    { $set: { activatedAt: INTERNAL_TIME } },
  );
  if (!complete) {
    await t.writer.materialize(t.scope);
    return { t, bookings: [] };
  }
  const attempts = new PaymentAttemptRepository(),
    refunds = new RefundOperationRepository();
  const relationships = new FinancialRelationshipService(
    new FinancialRelationshipRepository(),
    attempts,
    refunds,
    new BookingRepository(),
    new BookingCreationClaimRepository(),
    new ClientRepository(),
  );
  const payments = new PaymentService(
    new FakePaymentGateway(),
    new CustomerPaymentProfileRepository(),
    new UserRepository(),
    attempts,
    refunds,
  );
  const r = await new PackageBatchFinancialPersistence(
    t.writer,
    relationships,
    payments,
    () => INTERNAL_TIME,
  ).complete(t.scope);
  if (releaseForTest) await releaseCalendarTasksForTest();
  return { t, bookings: r.bookings };
}

/** Engineering fixture ONLY: the shipped consumer has no task-release authority. Raw writes
 * are confined to the disposable database. No production release API is introduced. */
async function releaseCalendarTasksForTest() {
  const row = await BookingCreationClaimModel.findOne().orFail();
  await BookingCreationClaimModel.collection.updateOne(
    { _id: row._id },
    {
      $set: {
        packageBatchDelivery: (row.packageBatchDelivery ?? []).map((task) =>
          task.port === "CALENDAR" ? { ...task, state: "PENDING" } : task,
        ),
      },
    },
  );
}

const calendarTasks = async () =>
  ((await BookingCreationClaimModel.findOne().orFail()).packageBatchDelivery ?? []).filter(
    (task) => task.port === "CALENDAR",
  );
const states = async () => (await calendarTasks()).map((task) => task.state).sort();

async function durableFixture(options: Parameters<typeof fakePackageCalendar>[0] = {}) {
  const { t, bookings } = await fixture(true, false);
  const booking = bookings[0];
  if (!booking) throw new Error("member required");
  const ownerId = String(t.f.business.ownerUserId);
  if (!(await UserModel.exists({ _id: ownerId })))
    await UserModel.create({
      _id: t.f.business.ownerUserId,
      normalizedEmail: "p2c-owner@example.test",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
      passwordHash: "unused",
      security: { passwordUpdatedAt: INTERNAL_TIME },
    });
  const ownerToken = await issueTestAccessToken(t.tokens, {
    userId: ownerId,
    role: "BUSINESS_OWNER",
  });
  const ownerProof = await new PackageCalendarOwnerAuthority(
    t.tokens,
    new UserRepository(),
  ).authenticate(`Bearer ${ownerToken}`);
  const c = fakePackageCalendar(options);
  let destination: CalendarDestination = {
    businessId: String(t.scope.businessId),
    integrationId: new Types.ObjectId().toHexString(),
    generation: randomUUID(),
    accountId: "google-test-subject",
    accountEmail: "p2c-owner@example.test",
    configuredCalendarId: "primary",
    calendarId: "p2c-owner@example.test",
  };
  let connected = true;
  let milliseconds = 0;
  const provider = {
    resolve: async () => {
      if (!connected) throw new PackageCalendarProviderError("BLOCKED_AUTHORITY", true);
      return { ...destination };
    },
    assertCurrent: async (value: CalendarDestination) => {
      if (!connected || JSON.stringify(value) !== JSON.stringify(destination))
        throw new PackageCalendarProviderError("BLOCKED_AUTHORITY", true);
    },
    bind: () => c.port,
  };
  const repository = new PackageCalendarRepository();
  const engine = () => new PackageCalendarDispatch(provider, repository, at(milliseconds));
  const first = (await calendarTasks()).find((task) => task.bookingId.equals(booking._id));
  const claim = await BookingCreationClaimModel.findOne().orFail();
  if (!first) throw new Error("task required");
  const reference: CalendarTaskReference = {
    kind: "BATCH",
    claimId: String(claim._id),
    key: first.key,
  };
  const release = async (
    task: CalendarTaskReference = reference,
    memberId: Types.ObjectId = booking._id,
  ) => {
    const current = await BookingModel.findById(memberId).orFail();
    return engine().release(
      task,
      {
        action: "RELEASE_EXACT_CALENDAR_TASK",
        actorUserId: ownerId,
        decisionId: randomUUID(),
        expectedRevision: calendarBookingIntent(current).revision,
        reason: "Explicit isolated engineering decision",
      },
      ownerProof,
    );
  };
  const lifecycle = new PackageLifecycleService(t.availability, t.reservations, t.booking, at(0));
  const progressId = booking.serviceLines[0]?.pricingInput.packageProgressId;
  if (!progressId) throw new Error("progress required");
  const change = async (action: "RESCHEDULE" | "CANCEL") => {
    const request = {
      action,
      key: `p2c-durable:${randomUUID()}`,
      bookingId: booking._id,
      businessId: t.scope.businessId,
      businessClientId: t.scope.businessClientId,
      packageProgressId: progressId,
      ...(action === "RESCHEDULE"
        ? { startAt: new Date(booking.schedule.startAt.getTime() + 86400000) }
        : {}),
    };
    await lifecycle.customer(t.scope.customer, request);
    const op = await PackageLifecycleOperationModel.findOne({ "intent.key": request.key }).orFail();
    return { kind: "LIFECYCLE" as const, operationId: String(op._id), index: 0 };
  };
  const journal = async () =>
    calendarJournalSchema.parse(
      (await repository.read(String(booking._id), String(t.scope.businessId)))
        ?.packageCalendarDelivery,
    );
  return {
    t,
    booking,
    c,
    reference,
    ownerId,
    ownerProof,
    engine,
    release,
    change,
    journal,
    repository,
    lifecycle,
    progressId,
    advance: (ms: number) => {
      milliseconds = ms;
    },
    connect: (value: boolean) => {
      connected = value;
    },
    reconnect: (change: Partial<CalendarDestination> = {}) => {
      destination = { ...destination, generation: randomUUID(), ...change };
    },
  };
}

describe("P2C package batch Calendar delivery (fake provider)", () => {
  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120000);
  beforeEach(clearIsolatedDatabase);
  afterAll(stopIsolatedReplicaSet);

  it("completed purchase remains blocked until an explicit test-only release; creates one event per member", async () => {
    const { t, bookings } = await fixture(true, false);
    expect(bookings.length).toBeGreaterThan(1);
    expect(await states()).toEqual(bookings.map(() => "BLOCKED_UNVERIFIED"));
    const c = fakePackageCalendar();
    expect(
      await new PackageBatchDeliveryRecovery(unusedReconcile, at(0), c.port).runOnce(t.scope),
    ).toEqual({ processed: 0 });
    expect(await states()).toEqual(bookings.map(() => "BLOCKED_UNVERIFIED"));
    expect(c.calls).toEqual([]);
    await releaseCalendarTasksForTest();
    await new PackageBatchDeliveryRecovery(unusedReconcile, at(0), c.port).runOnce(t.scope);
    expect(await states()).toEqual(bookings.map(() => "DONE"));
    const businessId = String(t.scope.businessId);
    for (const b of bookings) {
      const event = c.get(businessId, packageCalendarEventId(b._id));
      expect(event?.status).toBe("confirmed");
      expect(event?.startAt).toEqual(b.schedule.startAt);
      expect(event?.endAt).toEqual(b.schedule.endAt);
      expect(event?.timezone).toBe(b.schedule.timezone);
      expect(event?.description).toContain("Package session");
      expect(event?.marker).toEqual({
        booklyBookingId: b._id.toHexString(),
        booklyBusinessId: businessId,
      });
      expect(event?.summary).toBe(`Bookly — ${b.reference}`);
    }
    expect(c.live()).toHaveLength(bookings.length);
    expect(unusedReconcile.reconcileExisting).not.toHaveBeenCalled();
    // The Booking itself is never written by the consumer.
    for (const b of bookings)
      expect((await BookingModel.findById(b._id))?.googleCalendarEventId).toBeUndefined();
  });

  it("replay after DONE makes no provider call at all", async () => {
    const { t } = await fixture();
    const c = fakePackageCalendar();
    await new PackageBatchDeliveryRecovery(unusedReconcile, at(0), c.port).runOnce(t.scope);
    c.calls.length = 0;
    const again = await new PackageBatchDeliveryRecovery(
      unusedReconcile,
      at(600000),
      c.port,
    ).runOnce(t.scope);
    expect(again.processed).toBe(0);
    expect(c.calls).toEqual([]);
  });

  it("a materialized but commercially incomplete purchase is rejected before any provider call", async () => {
    const { t } = await fixture(false);
    const c = fakePackageCalendar();
    await expect(
      new PackageBatchDeliveryRecovery(unusedReconcile, at(0), c.port).runOnce(t.scope),
    ).rejects.toThrow();
    expect(c.calls).toEqual([]);
  });

  it("another Business's scope is rejected before any provider call", async () => {
    const { t } = await fixture();
    const c = fakePackageCalendar();
    await expect(
      new PackageBatchDeliveryRecovery(unusedReconcile, at(0), c.port).runOnce({
        ...t.scope,
        businessId: new Types.ObjectId(),
      }),
    ).rejects.toThrow();
    expect(c.calls).toEqual([]);
  });

  it("a forged customer capability is rejected before any provider call", async () => {
    const { t } = await fixture();
    const c = fakePackageCalendar();
    await expect(
      new PackageBatchDeliveryRecovery(unusedReconcile, at(0), c.port).runOnce({
        ...t.scope,
        customer: Object.create(null),
      }),
    ).rejects.toThrow();
    expect(c.calls).toEqual([]);
  });

  it("tampered member state fails authoritative completion validation before delivery", async () => {
    const { t, bookings } = await fixture();
    const [moved, cancelled] = bookings;
    if (!moved || !cancelled) throw new Error("two members required");
    // Negative fixtures only (raw writes inside the disposable database).
    await BookingModel.collection.updateOne(
      { _id: moved._id },
      { $set: { "schedule.startAt": new Date(moved.schedule.startAt.getTime() + 86400000) } },
    );
    await BookingModel.collection.updateOne(
      { _id: cancelled._id },
      { $set: { status: "CANCELLED_BY_CUSTOMER" } },
    );
    const c = fakePackageCalendar();
    await expect(
      new PackageBatchDeliveryRecovery(unusedReconcile, at(0), c.port).runOnce(t.scope),
    ).rejects.toThrow();
    expect(await states()).toEqual(bookings.map(() => "PENDING"));
    expect(c.calls).toEqual([]);
  });

  it("no connected calendar stays BLOCKED_UNVERIFIED with no write; never DONE", async () => {
    const { t, bookings } = await fixture();
    const c = fakePackageCalendar({ connected: () => false });
    await new PackageBatchDeliveryRecovery(unusedReconcile, at(0), c.port).runOnce(t.scope);
    expect(await states()).toEqual(bookings.map(() => "BLOCKED_UNVERIFIED"));
    expect(c.writes()).toEqual([]);
  });

  it("a lost insert response is RETRY; the later run converges on exactly one event", async () => {
    const { t, bookings } = await fixture();
    const c = fakePackageCalendar({ loseInsertResponses: 1 });
    await new PackageBatchDeliveryRecovery(unusedReconcile, at(0), c.port).runOnce(t.scope);
    expect(await states()).toEqual(["DONE", "RETRY"]);
    await new PackageBatchDeliveryRecovery(unusedReconcile, at(180000), c.port).runOnce(t.scope);
    expect(await states()).toEqual(bookings.map(() => "DONE"));
    expect(c.live()).toHaveLength(bookings.length);
    expect(c.writes().filter((w) => w.startsWith("insert:"))).toHaveLength(bookings.length);
  });

  it("a crash after the provider write recovers only after the lease and never duplicates", async () => {
    const { t, bookings } = await fixture();
    const c = fakePackageCalendar();
    const [task] = await calendarTasks();
    if (!task) throw new Error("no calendar task");
    // Simulated crashed worker: claimed the task and applied the provider write, then died.
    const lease = await claimBatchDeliveryTask(t.scope, task.key, INTERNAL_TIME);
    expect(lease?.state).toBe("PROCESSING");
    const member = bookings.find((b) => b._id.equals(task.bookingId));
    if (!member) throw new Error("no member");
    await c.port.insert(
      String(t.scope.businessId),
      packageCalendarEventId(task.bookingId),
      {
        summary: `Bookly — ${member.reference}`,
        description: "crashed worker",
        startAt: member.schedule.startAt,
        endAt: member.schedule.endAt,
        timezone: member.schedule.timezone,
      },
      {
        booklyBookingId: task.bookingId.toHexString(),
        booklyBusinessId: String(t.scope.businessId),
      },
    );
    // Lease still held: the leased task is not touched.
    await new PackageBatchDeliveryRecovery(unusedReconcile, at(60000), c.port).runOnce(t.scope);
    expect((await calendarTasks()).find((x) => x.key === task.key)?.state).toBe("PROCESSING");
    // Lease expired: the task is reclaimed, the event is observed (not re-created) and DONE.
    await new PackageBatchDeliveryRecovery(unusedReconcile, at(121000), c.port).runOnce(t.scope);
    expect(await states()).toEqual(bookings.map(() => "DONE"));
    expect(c.live()).toHaveLength(bookings.length);
    expect(
      c.writes().filter((w) => w === `insert:${packageCalendarEventId(task.bookingId)}`),
    ).toHaveLength(1);
  });

  it("concurrent consumers never produce a second event for a member", async () => {
    const { t, bookings } = await fixture();
    const c = fakePackageCalendar();
    await Promise.all([
      new PackageBatchDeliveryRecovery(unusedReconcile, at(0), c.port).runOnce(t.scope),
      new PackageBatchDeliveryRecovery(unusedReconcile, at(0), c.port).runOnce(t.scope),
    ]);
    // A consumer that lost a sibling CAS leaves that task for a later run.
    await new PackageBatchDeliveryRecovery(unusedReconcile, at(180000), c.port).runOnce(t.scope);
    expect(await states()).toEqual(bookings.map(() => "DONE"));
    expect(c.live()).toHaveLength(bookings.length);
    for (const b of bookings)
      expect(
        c.writes().filter((w) => w === `insert:${packageCalendarEventId(b._id)}`).length,
      ).toBeLessThanOrEqual(1);
  });

  it("a deleted deterministic event is never resurrected (BLOCKED_UNVERIFIED)", async () => {
    const { t, bookings } = await fixture();
    const c = fakePackageCalendar();
    await new PackageBatchDeliveryRecovery(unusedReconcile, at(0), c.port).runOnce(t.scope);
    const [b] = bookings;
    if (!b) throw new Error("no member");
    await c.port.remove(String(t.scope.businessId), packageCalendarEventId(b._id));
    // Re-open the task as an Owner-authorized replay would (negative fixture, raw write).
    const row = await BookingCreationClaimModel.findOne().orFail();
    await BookingCreationClaimModel.collection.updateOne(
      { _id: row._id },
      {
        $set: {
          packageBatchDelivery: (row.packageBatchDelivery ?? []).map((task) =>
            task.port === "CALENDAR" && task.bookingId.equals(b._id)
              ? { ...task, state: "RETRY", nextDue: INTERNAL_TIME }
              : task,
          ),
        },
      },
    );
    c.calls.length = 0;
    await new PackageBatchDeliveryRecovery(unusedReconcile, at(0), c.port).runOnce(t.scope);
    expect((await calendarTasks()).find((task) => task.bookingId.equals(b._id))?.state).toBe(
      "BLOCKED_UNVERIFIED",
    );
    expect(c.writes()).toEqual([]);
  });

  it.each(["missing-proof", "finance-hash", "task-owner"])(
    "%s is rejected before claiming or calling the Calendar port",
    async (fault) => {
      const { t, bookings } = await fixture();
      const row = await BookingCreationClaimModel.findOne().orFail();
      const mutation =
        fault === "missing-proof"
          ? { $unset: { packageBatchCompletion: "" } }
          : {
              $set: {
                [fault === "finance-hash"
                  ? "packageBatchCompletion.financeHash"
                  : "packageBatchDelivery.0.bookingId"]:
                  fault === "finance-hash" ? "0".repeat(64) : new Types.ObjectId(),
              },
            };
      await BookingCreationClaimModel.collection.updateOne({ _id: row._id }, mutation);
      const c = fakePackageCalendar();
      await expect(
        new PackageBatchDeliveryRecovery(unusedReconcile, at(0), c.port).runOnce(t.scope),
      ).rejects.toThrow();
      expect(c.calls).toEqual([]);
      expect(await states()).toEqual(bookings.map(() => "PENDING"));
    },
  );

  it("a missing observation after an ambiguous insert blocks instead of issuing another create", async () => {
    const { t } = await fixture();
    const c = fakePackageCalendar({ loseInsertResponses: 1 });
    await new PackageBatchDeliveryRecovery(unusedReconcile, at(0), c.port).runOnce(t.scope);
    const initialWrites = [...c.writes()];
    c.port.read = async () => ({ outcome: "NOT_FOUND" });
    await new PackageBatchDeliveryRecovery(unusedReconcile, at(180000), c.port).runOnce(t.scope);
    expect(await states()).toEqual(["BLOCKED_UNVERIFIED", "DONE"]);
    expect(c.writes()).toEqual(initialWrites);
  });

  it("missing real-adapter write authority blocks rather than retrying or attesting success", async () => {
    const { t, bookings } = await fixture();
    const c = fakePackageCalendar();
    c.port.insert = async () => {
      throw new PackageCalendarWriteAuthorityUnavailableError();
    };
    await new PackageBatchDeliveryRecovery(unusedReconcile, at(0), c.port).runOnce(t.scope);
    expect(await states()).toEqual(bookings.map(() => "BLOCKED_UNVERIFIED"));
    expect(c.live()).toEqual([]);
  });

  it("provider timeout leaves RETRY; a later missing event cannot authorize a second attempt", async () => {
    const { t, bookings } = await fixture();
    const c = fakePackageCalendar();
    const read = c.port.read;
    c.port.read = async () => {
      throw new Error("controlled provider timeout");
    };
    await new PackageBatchDeliveryRecovery(unusedReconcile, at(0), c.port).runOnce(t.scope);
    expect(await states()).toEqual(bookings.map(() => "RETRY"));
    c.port.read = read;
    await new PackageBatchDeliveryRecovery(unusedReconcile, at(180000), c.port).runOnce(t.scope);
    expect(await states()).toEqual(bookings.map(() => "BLOCKED_UNVERIFIED"));
    expect(c.writes()).toEqual([]);
  });

  describe("durable destination, release and shared dispatch", () => {
    it("explicitly releases only the selected verified task, persists identity, and survives restart", async () => {
      const d = await durableFixture();
      expect(await d.engine().deliver(d.reference)).toBe("BLOCKED_UNVERIFIED");
      expect(await states()).toEqual(["BLOCKED_UNVERIFIED", "BLOCKED_UNVERIFIED"]);
      const released = await d.release();
      expect(await states()).toEqual(["BLOCKED_UNVERIFIED", "PENDING"]);
      expect(released.destination.calendarId).not.toBe("primary");
      expect(released.latest.task).toEqual(d.reference);
      expect(await d.engine().deliver(d.reference)).toBe("DONE");
      expect((await d.journal()).state).toBe("CONFIRMED_DELIVERED");
      expect((await BookingModel.findById(d.booking._id))?.googleCalendarEventId).toBe(
        released.eventId,
      );
      expect(await d.engine().deliver(d.reference)).toBe("DONE");
      expect(d.c.writes().filter((call) => call.startsWith("insert:"))).toHaveLength(1);
    });

    it("unknown insert plus a missing provider observation blocks without another create", async () => {
      const d = await durableFixture({ loseInsertResponses: 1 });
      await d.release();
      expect(await d.engine().deliver(d.reference)).toBe("RETRY");
      expect((await d.journal()).state).toBe("UNKNOWN_OUTCOME");
      const read = d.c.port.read;
      d.c.port.read = async () => ({ outcome: "NOT_FOUND" });
      d.advance(120000);
      expect(await d.engine().deliver(d.reference)).toBe("BLOCKED_UNVERIFIED");
      expect(d.c.writes().filter((call) => call.startsWith("insert:"))).toHaveLength(1);
      d.c.port.read = read;
      expect(await d.engine().deliver(d.reference)).toBe("DONE");
      expect((await d.journal()).request?.settled).toBe(false);
    });

    it.each(["PATCH", "DELETE"] as const)(
      "unknown %s is reconciled by observation without another mutation",
      async (kind) => {
        const d = await durableFixture(
          kind === "PATCH" ? { losePatchResponses: 1 } : { loseDeleteResponses: 1 },
        );
        await d.release();
        expect(await d.engine().deliver(d.reference)).toBe("DONE");
        const task = await d.change(kind === "PATCH" ? "RESCHEDULE" : "CANCEL");
        await d.release(task);
        expect(await d.engine().deliver(task)).toBe("RETRY");
        expect((await d.journal()).state).toBe("UNKNOWN_OUTCOME");
        const writes = [...d.c.writes()];
        expect(await d.engine().deliver(task)).toBe("DONE");
        expect(d.c.writes()).toEqual(writes);
        expect(await d.engine().deliver(d.reference)).toBe("SKIPPED");
      },
    );

    it("concurrent workers share one persistent claim across restarts", async () => {
      const d = await durableFixture();
      await d.release();
      await Promise.all([d.engine().deliver(d.reference), d.engine().deliver(d.reference)]);
      d.advance(120000);
      expect(await d.engine().deliver(d.reference)).toBe("DONE");
      expect(d.c.writes().filter((call) => call.startsWith("insert:"))).toHaveLength(1);
    });

    it("a new current lifecycle task waits for its own release decision instead of being terminally skipped", async () => {
      const d = await durableFixture();
      await d.release();
      expect(await d.engine().deliver(d.reference)).toBe("DONE");
      const moved = await d.change("RESCHEDULE");
      const writes = [...d.c.writes()];
      expect(await d.engine().deliver(moved)).toBe("BLOCKED_UNVERIFIED");
      expect(d.c.writes()).toEqual(writes);
      await d.release(moved);
      expect(await d.engine().deliver(moved)).toBe("DONE");
    });

    it("reclaims expired preparation before issuing a request and rejects the previous CAS", async () => {
      const d = await durableFixture();
      await d.release();
      const booking = await d.repository.read(String(d.booking._id), String(d.booking.businessId));
      if (!booking) throw new Error("booking missing");
      const old = await d.journal();
      const prepared = {
        ...old,
        state: "DISPATCH_PREPARED" as const,
        lease: { token: randomUUID(), expiresAt: new Date(INTERNAL_TIME.getTime() - 1) },
      };
      expect(await d.repository.compareAndSet(booking, old, prepared)).toBe(true);
      expect(await d.engine().deliver(d.reference)).toBe("DONE");
      expect(await d.repository.compareAndSet(booking, prepared, old)).toBe(false);
    });

    it("a definite rejection can retry; a permanent rejection stays visible and blocked", async () => {
      const d = await durableFixture();
      await d.release();
      const insert = d.c.port.insert;
      d.c.port.insert = async () => {
        throw new PackageCalendarProviderError("RETRYABLE_FAILURE", true);
      };
      expect(await d.engine().deliver(d.reference)).toBe("RETRY");
      expect((await d.journal()).createIssued).toBe(false);
      expect((await d.journal()).state).toBe("RETRYABLE_FAILURE");
      d.c.port.insert = async () => {
        throw new PackageCalendarProviderError("PERMANENT_FAILURE", true);
      };
      expect(await d.engine().deliver(d.reference)).toBe("BLOCKED_UNVERIFIED");
      expect((await d.journal()).state).toBe("PERMANENT_FAILURE");
      d.c.port.insert = insert;
      expect(await d.engine().deliver(d.reference)).toBe("BLOCKED_UNVERIFIED");
      expect(d.c.writes()).toEqual([]);
    });

    it("expired unissued preparation can be reclaimed; an issued request cannot be stolen", async () => {
      const d = await durableFixture();
      await d.release();
      let booking = await d.repository.read(String(d.booking._id), String(d.booking.businessId));
      if (!booking) throw new Error("booking missing");
      const prior = await d.journal();
      const issued = {
        ...prior,
        state: "REQUEST_ISSUED" as const,
        createIssued: true,
        lease: { token: randomUUID(), expiresAt: new Date(INTERNAL_TIME.getTime() - 1) },
        request: {
          id: randomUUID(),
          kind: "INSERT" as const,
          revision: prior.latest.revision,
          issuedAt: INTERNAL_TIME,
          settled: false,
        },
      };
      expect(await d.repository.compareAndSet(booking, prior, issued)).toBe(true);
      d.advance(120000);
      expect(await d.engine().deliver(d.reference)).toBe("BLOCKED_UNVERIFIED");
      expect(d.c.writes()).toEqual([]);
      await d.engine().recover(
        {
          bookingId: String(d.booking._id),
          businessId: String(d.booking.businessId),
          actorUserId: d.ownerId,
          requestId: issued.request.id,
          incidentReference: "TEST-QUIESCED-1",
          assertion: "ALL_ISSUERS_QUIESCED_AND_PROVIDER_SETTLED",
        },
        d.ownerProof,
      );
      // Even explicit quiescence cannot turn an uncertain absent insert into permission to recreate.
      expect(await d.engine().deliver(d.reference)).toBe("BLOCKED_UNVERIFIED");
      booking = await d.repository.read(String(d.booking._id), String(d.booking.businessId));
      if (!booking) throw new Error("booking missing");
      expect(await d.repository.compareAndSet(booking, prior, issued)).toBe(false);
    });

    it("same-account reconnect needs an explicit decision; different accounts/calendars cannot be adopted", async () => {
      const d = await durableFixture();
      await d.release();
      d.reconnect();
      expect(await d.engine().deliver(d.reference)).toBe("BLOCKED_UNVERIFIED");
      expect(d.c.writes()).toEqual([]);
      const recovery = {
        bookingId: String(d.booking._id),
        businessId: String(d.booking.businessId),
        actorUserId: d.ownerId,
        incidentReference: "TEST-RECONNECT",
        assertion: "ALL_ISSUERS_QUIESCED_AND_PROVIDER_SETTLED" as const,
      };
      await d.engine().recover(recovery, d.ownerProof);
      expect(await d.engine().deliver(d.reference)).toBe("DONE");
      d.reconnect({ accountEmail: "other@example.test" });
      await expect(d.engine().recover(recovery, d.ownerProof)).rejects.toThrow();
      expect(await d.engine().deliver(d.reference)).toBe("BLOCKED_UNVERIFIED");
      d.reconnect({ accountEmail: "p2c-owner@example.test", accountId: "different-subject" });
      await expect(d.engine().recover(recovery, d.ownerProof)).rejects.toThrow();
      d.reconnect({ accountId: "google-test-subject", calendarId: "other-calendar" });
      await expect(d.engine().recover(recovery, d.ownerProof)).rejects.toThrow();
    });

    it("OAuth reconnection rotates generation and prevents an old refresh from overwriting new credentials", async () => {
      const repository = new IntegrationRepository();
      const input = {
        businessId: new Types.ObjectId(),
        googleAccountId: "stable-google-subject",
        googleAccountEmail: "p2c-owner@example.test",
        calendarId: "primary",
        encryptedAccessToken: "test-token-one",
        encryptedRefreshToken: "test-refresh-one",
        tokenExpiresAt: new Date(INTERNAL_TIME.getTime() + 3600000),
      };
      const first = await repository.upsert(input);
      const second = await repository.upsert({ ...input, encryptedAccessToken: "test-token-two" });
      expect(second.connectionGeneration).not.toBe(first.connectionGeneration);
      expect(second.googleAccountId).toBe(first.googleAccountId);
      expect(
        await repository.updateTokens(
          first._id,
          {
            encryptedAccessToken: "stale-refresh-result",
            encryptedRefreshToken: "stale-refresh",
            tokenExpiresAt: input.tokenExpiresAt,
          },
          first.connectionGeneration,
        ),
      ).toBe(false);
      expect((await repository.findByBusinessId(input.businessId))?.encryptedAccessToken).toBe(
        "test-token-two",
      );
    });

    it("disconnection, cross-tenant release and missing durable identity fail closed", async () => {
      const d = await durableFixture();
      await expect(
        d.engine().release(
          d.reference,
          {
            action: "RELEASE_EXACT_CALENDAR_TASK",
            actorUserId: d.ownerId,
            decisionId: randomUUID(),
            expectedRevision: calendarBookingIntent(d.booking).revision,
            reason: "forged session proof",
          },
          Object.create(null),
        ),
      ).rejects.toThrow();
      const live = vi.spyOn(d.t.tokens, "isAccessTokenSessionLive").mockResolvedValue(false);
      try {
        await expect(d.release()).rejects.toThrow();
      } finally {
        live.mockRestore();
      }
      await expect(
        d.engine().release(
          d.reference,
          {
            action: "RELEASE_EXACT_CALENDAR_TASK",
            actorUserId: new Types.ObjectId().toHexString(),
            decisionId: randomUUID(),
            expectedRevision: calendarBookingIntent(d.booking).revision,
            reason: "forged owner",
          },
          d.ownerProof,
        ),
      ).rejects.toThrow();
      await d.release();
      d.connect(false);
      expect(await d.engine().deliver(d.reference)).toBe("BLOCKED_UNVERIFIED");
      d.connect(true);
      await BookingModel.collection.updateOne(
        { _id: d.booking._id },
        { $unset: { "packageCalendarDelivery.eventId": "" } },
      );
      await expect(d.engine().deliver(d.reference)).rejects.toThrow();
      expect(d.c.writes()).toEqual([]);
    });

    it("a verified later-redemption member uses the same release and dispatch contract", async () => {
      const d = await durableFixture();
      const progress = await PackageProgressV2Model.findById(d.progressId).orFail();
      const item = progress.items[0];
      const line = d.booking.serviceLines[0];
      if (!item || !line) throw new Error("redemption fixture missing");
      const request = {
        key: `p2c-redeem:${randomUUID()}`,
        action: "REDEEM" as const,
        businessId: d.t.scope.businessId,
        businessClientId: d.t.scope.businessClientId,
        packageProgressId: progress._id,
        packageItemId: item.packageItemId,
        staffMembershipId: line.responsibleStaffMembershipId,
        startAt: new Date(d.booking.schedule.startAt.getTime() + 86400000),
      };
      await d.lifecycle.customer(d.t.scope.customer, request);
      const operation = await PackageLifecycleOperationModel.findOne({
        "intent.key": request.key,
      }).orFail();
      if (!operation.bookingId) throw new Error("redemption booking missing");
      const reference = {
        kind: "LIFECYCLE" as const,
        operationId: String(operation._id),
        index: 0,
      };
      await d.release(reference, operation.bookingId);
      expect(await d.engine().deliver(reference)).toBe("DONE");
      const member = await BookingModel.findById(operation.bookingId).orFail();
      expect(member.googleCalendarEventId).toBe(packageCalendarEventId(operation.bookingId));
    });

    it.each(["RESCHEDULE", "CANCEL"] as const)(
      "%s racing an in-flight insert waits, then reconciles the latest intent",
      async (action) => {
        const d = await durableFixture();
        await d.release();
        let enter!: () => void;
        let resume!: () => void;
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
          resume = resolve;
        });
        const insert = d.c.port.insert;
        d.c.port.insert = async (...args) => {
          enter();
          await barrier;
          return insert(...args);
        };
        const pending = d.engine().deliver(d.reference);
        await entered;
        const latest = await d.change(action);
        await d.release(latest);
        expect(await d.engine().deliver(latest)).toBe("BLOCKED_UNVERIFIED");
        expect((await d.journal()).state).toBe("UNKNOWN_OUTCOME");
        resume();
        expect(await pending).toBe("SKIPPED");
        expect(await d.engine().deliver(latest)).toBe("DONE");
        if (action === "CANCEL") expect(d.c.live()).toEqual([]);
        else
          expect(d.c.live()[0]?.startAt).toEqual(
            new Date(d.booking.schedule.startAt.getTime() + 86400000),
          );
        expect(d.c.writes().filter((call) => call.startsWith("insert:"))).toHaveLength(1);
      },
    );
  });

  it("committed package reschedule patches the same event; cancellation removes it", async () => {
    const { t, bookings } = await fixture();
    const b = bookings[0];
    if (!b) throw new Error("member required");
    const c = fakePackageCalendar();
    await new PackageBatchDeliveryRecovery(unusedReconcile, at(0), c.port).runOnce(t.scope);
    const progressId = b.serviceLines[0]?.pricingInput.packageProgressId;
    if (!progressId) throw new Error("progress required");
    const service = new PackageLifecycleService(t.availability, t.reservations, t.booking, at(0));
    const move = {
      key: `p2c-move:${b._id}`,
      action: "RESCHEDULE" as const,
      businessId: t.scope.businessId,
      businessClientId: t.scope.businessClientId,
      packageProgressId: progressId,
      bookingId: b._id,
      startAt: new Date(b.schedule.startAt.getTime() + 86400000),
    };
    await service.customer(t.scope.customer, move);
    const op = await PackageLifecycleOperationModel.findOne({ "intent.key": move.key }).orFail();
    const consumer = new PackageLifecycleDeliveryRecovery(unusedReconcile, at(0), c.port);
    await consumer.runOnce(t.scope.customer, op._id);
    const eventId = packageCalendarEventId(b._id);
    expect(c.get(String(t.scope.businessId), eventId)?.startAt).toEqual(move.startAt);
    expect((await PackageLifecycleOperationModel.findById(op._id))?.delivery?.[0]?.state).toBe(
      "DONE",
    );
    const cancel = {
      key: `p2c-cancel:${b._id}`,
      action: "CANCEL" as const,
      businessId: move.businessId,
      businessClientId: move.businessClientId,
      packageProgressId: progressId,
      bookingId: b._id,
    };
    await service.customer(t.scope.customer, cancel);
    const cancelled = await PackageLifecycleOperationModel.findOne({
      "intent.key": cancel.key,
    }).orFail();
    await consumer.runOnce(t.scope.customer, cancelled._id);
    expect(c.get(String(t.scope.businessId), eventId)?.status).toBe("cancelled");
    expect(
      (await PackageLifecycleOperationModel.findById(cancelled._id))?.delivery?.[0]?.state,
    ).toBe("DONE");
    expect(c.writes().filter((w) => w === `insert:${eventId}`)).toHaveLength(1);
    expect((await BookingModel.findById(b._id))?.googleCalendarEventId).toBeUndefined();
  });
});
