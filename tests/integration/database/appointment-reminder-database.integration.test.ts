import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppointmentReminderModel } from "../../../src/modules/appointment-reminder/appointment-reminder.model.js";
import { AppointmentReminderRepository } from "../../../src/modules/appointment-reminder/appointment-reminder.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

type DbIndex = { name?: string; key: Record<string, unknown>; unique?: boolean };

const H = 60 * 60 * 1000;

const scheduleInput = (overrides: Record<string, unknown> = {}) => {
  const scheduleStartAt = new Date(Date.now() + 72 * H); // 3 days out → PENDING
  return {
    kind: "REMINDER_24H" as const,
    bookingId: new Types.ObjectId("650000000000000000000001"),
    businessId: new Types.ObjectId("650000000000000000000002"),
    customerUserId: new Types.ObjectId("650000000000000000000003"),
    scheduleStartAt,
    now: new Date(),
    ...overrides,
  };
};

describe("database-backed AppointmentReminder integration", () => {
  let repository: AppointmentReminderRepository;

  /** A genuinely-PENDING reminder that is ALSO due now — schedule a future one (so the
   * late-booking guard keeps it PENDING) then backdate `dueAt` as the wall clock would. */
  const schedulePendingDueNow = async (
    overrides: Record<string, unknown> = {},
  ): Promise<string> => {
    const { record } = await repository.schedule(scheduleInput(overrides));
    await AppointmentReminderModel.updateOne(
      { _id: record._id },
      { $set: { dueAt: new Date(Date.now() - 60_000) } },
    );
    return record._id.toString();
  };

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    repository = new AppointmentReminderRepository();
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  it("has a unique index on dedupeKey plus the claim / recovery / retire indexes", async () => {
    const indexes = (await AppointmentReminderModel.collection.indexes()) as DbIndex[];
    expect(indexes.find((i) => i.key["dedupeKey"] === 1)?.unique).toBe(true);
    expect(indexes.some((i) => i.key["status"] === 1 && i.key["dueAt"] === 1)).toBe(true);
    expect(indexes.some((i) => i.key["status"] === 1 && i.key["claimedAt"] === 1)).toBe(true);
    expect(indexes.some((i) => i.key["bookingId"] === 1 && i.key["status"] === 1)).toBe(true);
  });

  it("schedules exactly one PENDING reminder with dueAt = startAt - 24h", async () => {
    const input = scheduleInput();
    const result = await repository.schedule(input);

    expect(result.created).toBe(true);
    expect(result.record.status).toBe("PENDING");
    expect(result.record.dueAt.getTime()).toBe(input.scheduleStartAt.getTime() - 24 * H);
    expect(result.record.offsetMinutes).toBe(1440);
    expect(await AppointmentReminderModel.countDocuments({})).toBe(1);
  });

  it("a duplicate scheduling call is idempotent — same logical identity, one row", async () => {
    const input = scheduleInput();
    const first = await repository.schedule(input);
    const second = await repository.schedule({ ...input, now: new Date() });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.record._id.toString()).toBe(first.record._id.toString());
    expect(await AppointmentReminderModel.countDocuments({})).toBe(1);
  });

  it("a booking inside the 24h window is persisted terminal SKIPPED, never PENDING", async () => {
    const result = await repository.schedule(
      scheduleInput({ scheduleStartAt: new Date(Date.now() + 1 * H) }),
    );
    expect(result.record.status).toBe("SKIPPED");
    expect(result.record.emailDecision).toBe("SKIPPED_INELIGIBLE");
    // never claimable
    expect(
      await repository.claimNext({
        workerId: "w",
        now: new Date(),
        claimTimeoutMs: 1000,
        maxAttempts: 5,
      }),
    ).toBeNull();
  });

  it("claimNext atomically moves one due PENDING row to PROCESSING and won't re-hand it out", async () => {
    await schedulePendingDueNow();

    const claim = { workerId: "w1", now: new Date(), claimTimeoutMs: 120_000, maxAttempts: 5 };
    const claimed = await repository.claimNext(claim);
    expect(claimed?.status).toBe("PROCESSING");
    expect(claimed?.attemptCount).toBe(1);

    const again = await repository.claimNext({ ...claim, workerId: "w2" });
    expect(again).toBeNull();
  });

  it("resetStaleProcessing returns a stale PROCESSING row to PENDING", async () => {
    const id = await schedulePendingDueNow();
    const claimed = await repository.claimNext({
      workerId: "w1",
      now: new Date(),
      claimTimeoutMs: 120_000,
      maxAttempts: 5,
    });
    expect(claimed?.status).toBe("PROCESSING");
    // simulate the worker crashing mid-process: its claim goes stale
    await AppointmentReminderModel.updateOne(
      { _id: id },
      { $set: { claimedAt: new Date(Date.now() - 10 * 60_000) } },
    );

    const recovered = await repository.resetStaleProcessing(new Date(Date.now() - 5 * 60_000));
    expect(recovered).toBe(1);
    const row = await AppointmentReminderModel.findOne({});
    expect(row?.status).toBe("PENDING");
  });

  it("retireActiveForBooking cancels PENDING/PROCESSING rows but leaves terminal rows immutable", async () => {
    const bookingId = new Types.ObjectId();
    const pending = await repository.schedule(scheduleInput({ bookingId }));
    // a second, already-COMPLETED reminder for the same booking (an earlier schedule version)
    await AppointmentReminderModel.create({
      dedupeKey: `APPOINTMENT_REMINDER_24H:${bookingId}:999`,
      kind: "REMINDER_24H",
      bookingId,
      businessId: new Types.ObjectId(),
      customerUserId: new Types.ObjectId(),
      offsetMinutes: 1440,
      scheduleStartAt: new Date(999),
      dueAt: new Date(0),
      status: "COMPLETED",
      attemptCount: 1,
      emailDecision: "ENQUEUED",
    });

    const retired = await repository.retireActiveForBooking(
      bookingId,
      "BOOKING_CANCELLED_BY_CUSTOMER",
      {
        now: new Date(),
      },
    );

    expect(retired).toBe(1);
    expect((await AppointmentReminderModel.findById(pending.record._id))?.status).toBe("CANCELLED");
    expect(
      (
        await AppointmentReminderModel.findOne({
          dedupeKey: `APPOINTMENT_REMINDER_24H:${bookingId}:999`,
        })
      )?.status,
    ).toBe("COMPLETED");
  });

  it("retireActiveForBooking with exceptDedupeKey keeps the new schedule version active (reschedule)", async () => {
    const bookingId = new Types.ObjectId();
    const oldStart = new Date(Date.now() + 72 * H);
    const newStart = new Date(Date.now() + 96 * H);

    const oldRow = await repository.schedule(
      scheduleInput({ bookingId, scheduleStartAt: oldStart }),
    );
    const newRow = await repository.schedule(
      scheduleInput({ bookingId, scheduleStartAt: newStart, now: new Date() }),
    );

    const retired = await repository.retireActiveForBooking(bookingId, "SUPERSEDED_BY_RESCHEDULE", {
      now: new Date(),
      exceptDedupeKey: newRow.record.dedupeKey,
    });

    expect(retired).toBe(1);
    expect((await AppointmentReminderModel.findById(oldRow.record._id))?.status).toBe("CANCELLED");
    expect((await AppointmentReminderModel.findById(newRow.record._id))?.status).toBe("PENDING");
  });

  it("claimNext assigns a per-claim UNIQUE ownership token; successive claims differ", async () => {
    await schedulePendingDueNow();
    const c1 = await repository.claimNext({
      workerId: "w1",
      now: new Date(),
      claimTimeoutMs: 120_000,
      maxAttempts: 5,
    });
    if (!c1) throw new Error("claim failed");
    expect(c1.claimedBy).toMatch(/^w1:[0-9a-f]{24}$/);

    // force it stale so it can be reclaimed
    await AppointmentReminderModel.updateOne(
      { _id: c1._id },
      { $set: { claimedAt: new Date(Date.now() - 10 * 60_000) } },
    );
    const c2 = await repository.claimNext({
      workerId: "w2",
      now: new Date(),
      claimTimeoutMs: 120_000,
      maxAttempts: 5,
    });
    expect(c2?.claimedBy).toMatch(/^w2:[0-9a-f]{24}$/);
    expect(c2?.claimedBy).not.toBe(c1?.claimedBy);
  });

  it("recordChannelDecision: PENDING → final, immutable, and auto-completes when the other channel is final", async () => {
    await schedulePendingDueNow();
    const claimed = await repository.claimNext({
      workerId: "w1",
      now: new Date(),
      claimTimeoutMs: 120_000,
      maxAttempts: 5,
    });
    if (!claimed?.claimedBy) throw new Error("claim failed");
    const token = claimed.claimedBy;

    // 1st channel: email → status stays PROCESSING (sms still PENDING)
    const afterEmail = await repository.recordChannelDecision(claimed._id, token, {
      channel: "email",
      decision: "ENQUEUED",
      outboxDedupeKey: "EMAIL_KEY",
      now: new Date(),
    });
    expect(afterEmail?.emailDecision).toBe("ENQUEUED");
    expect(afterEmail?.emailOutboxDedupeKey).toBe("EMAIL_KEY");
    expect(afterEmail?.status).toBe("PROCESSING");

    // immutability: a second email decision matches zero rows
    const replay = await repository.recordChannelDecision(claimed._id, token, {
      channel: "email",
      decision: "SUPPRESSED_BY_PREFERENCE",
      now: new Date(),
    });
    expect(replay).toBeNull();
    expect((await AppointmentReminderModel.findById(claimed._id))?.emailDecision).toBe("ENQUEUED");

    // 2nd channel: sms → both final → auto-COMPLETED, claim cleared
    const afterSms = await repository.recordChannelDecision(claimed._id, token, {
      channel: "sms",
      decision: "SUPPRESSED_BY_PREFERENCE",
      now: new Date(),
    });
    expect(afterSms?.smsDecision).toBe("SUPPRESSED_BY_PREFERENCE");
    expect(afterSms?.status).toBe("COMPLETED");
    expect(afterSms?.processedAt).toBeInstanceOf(Date);
    expect(afterSms?.claimedBy).toBeUndefined();
  });

  it("ownership fence: a stale claim token cannot freeze a recipient, record a decision, skip, or release", async () => {
    await schedulePendingDueNow();
    const a = await repository.claimNext({
      workerId: "wA",
      now: new Date(),
      claimTimeoutMs: 120_000,
      maxAttempts: 5,
    });
    if (!a) throw new Error("claim failed");
    const staleToken = a.claimedBy as string;
    const rid = a._id;

    // worker B stale-reclaims
    await AppointmentReminderModel.updateOne(
      { _id: rid },
      { $set: { claimedAt: new Date(Date.now() - 10 * 60_000) } },
    );
    const b = await repository.claimNext({
      workerId: "wB",
      now: new Date(),
      claimTimeoutMs: 120_000,
      maxAttempts: 5,
    });
    const liveToken = b?.claimedBy as string;
    expect(liveToken).not.toBe(staleToken);

    // every write with the STALE token matches zero rows
    expect(
      await repository.freezeChannelRecipient(rid, staleToken, {
        channel: "email",
        recipient: "stale@x.y",
      }),
    ).toBeNull();
    expect(
      await repository.recordChannelDecision(rid, staleToken, {
        channel: "email",
        decision: "ENQUEUED",
        now: new Date(),
      }),
    ).toBeNull();
    expect(
      await repository.markSkipped(rid, staleToken, {
        reasonCategory: "STALE",
        now: new Date(),
      }),
    ).toBeNull();
    expect(
      await repository.releaseForRetryOrFail(rid, staleToken, {
        category: "STALE",
        message: "x",
        attemptsExhausted: false,
        now: new Date(),
      }),
    ).toBeNull();

    // the LIVE token still works
    expect(
      await repository.freezeChannelRecipient(rid, liveToken, {
        channel: "email",
        recipient: "live@x.y",
      }),
    ).not.toBeNull();
    expect((await AppointmentReminderModel.findById(rid))?.emailRecipient).toBe("live@x.y");
  });

  it("freezeChannelRecipient is set-once — a second freeze keeps the original value", async () => {
    await schedulePendingDueNow();
    const claimed = await repository.claimNext({
      workerId: "w1",
      now: new Date(),
      claimTimeoutMs: 120_000,
      maxAttempts: 5,
    });
    const token = claimed?.claimedBy as string;

    await repository.freezeChannelRecipient(claimed?._id as Types.ObjectId, token, {
      channel: "sms",
      recipient: "+35799111111",
    });
    const second = await repository.freezeChannelRecipient(claimed?._id as Types.ObjectId, token, {
      channel: "sms",
      recipient: "+35799222222",
    });
    expect(second?.smsRecipientE164).toBe("+35799111111");
  });

  it("retireActiveForBooking overrides worker ownership (no token needed) and fences later worker writes", async () => {
    await schedulePendingDueNow();
    const claimed = await repository.claimNext({
      workerId: "w1",
      now: new Date(),
      claimTimeoutMs: 120_000,
      maxAttempts: 5,
    });
    const token = claimed?.claimedBy as string;
    const bookingId = claimed?.bookingId as Types.ObjectId;

    const retired = await repository.retireActiveForBooking(
      bookingId,
      "BOOKING_CANCELLED_BY_CUSTOMER",
      {
        now: new Date(),
      },
    );
    expect(retired).toBe(1);
    expect((await AppointmentReminderModel.findById(claimed?._id))?.status).toBe("CANCELLED");

    // the worker (still holding a valid token) can no longer mutate it
    expect(
      await repository.recordChannelDecision(claimed?._id as Types.ObjectId, token, {
        channel: "email",
        decision: "ENQUEUED",
        now: new Date(),
      }),
    ).toBeNull();
  });

  it("schedule() writes smsDecision:PENDING for a normal row and SKIPPED_INELIGIBLE for a late row", async () => {
    const normal = await repository.schedule(scheduleInput());
    expect(normal.record.smsDecision).toBe("PENDING");
    const late = await repository.schedule(
      scheduleInput({ scheduleStartAt: new Date(Date.now() + 1 * H) }),
    );
    expect(late.record.smsDecision).toBe("SKIPPED_INELIGIBLE");
    expect(late.record.emailDecision).toBe("SKIPPED_INELIGIBLE");
  });
});
