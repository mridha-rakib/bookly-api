import mongoose, { type ClientSession, Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppointmentReminderModel } from "../../../src/modules/appointment-reminder/appointment-reminder.model.js";
import { AppointmentReminderRepository } from "../../../src/modules/appointment-reminder/appointment-reminder.repository.js";
import { EmailOutboxModel } from "../../../src/modules/email-outbox/email-outbox.model.js";
import { EmailOutboxRepository } from "../../../src/modules/email-outbox/email-outbox.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

// These tests establish delivery repository composition only, not purchased batch authority.
const emails = new EmailOutboxRepository();
const reminders = new AppointmentReminderRepository();
const now = new Date("2030-08-19T09:00:00Z");
const reminder = (bookingId: Types.ObjectId) => ({
  kind: "REMINDER_24H" as const,
  bookingId,
  businessId: new Types.ObjectId("650000000000000000000002"),
  customerUserId: new Types.ObjectId("650000000000000000000003"),
  scheduleStartAt: new Date("2030-08-22T09:00:00Z"),
  now,
});
const email = (bookingId: Types.ObjectId) => ({
  eventKey: `BOOKING_CREATED:${bookingId.toHexString()}`,
  templateKey: "BOOKING_CUSTOMER_CONFIRMED" as const,
  recipient: "buyer@example.com",
  payload: { bookingId: bookingId.toHexString() },
});
const transaction = async (work: (session: ClientSession) => Promise<void>) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(() => work(session));
  } finally {
    await session.endSession();
  }
};

describe("D1 delivery repository composition in an owned transaction", () => {
  beforeAll(connectIsolatedDatabase, 120000);
  beforeEach(clearIsolatedDatabase);
  afterAll(stopIsolatedReplicaSet);

  it("commits every sibling email and reminder in the parent's transaction", async () => {
    const siblings = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
    await transaction(async (session) => {
      for (const id of siblings) {
        await emails.enqueue(email(id), session);
        await reminders.schedule(reminder(id), session);
      }
      expect(await EmailOutboxModel.countDocuments({}).session(session)).toBe(3);
      expect(await AppointmentReminderModel.countDocuments({}).session(session)).toBe(3);
      // A separate observer sees none of these tentative rows.
      expect(await EmailOutboxModel.countDocuments({})).toBe(0);
      expect(await AppointmentReminderModel.countDocuments({})).toBe(0);
    });
    expect((await EmailOutboxModel.find({}).lean()).map((row) => row.eventKey).sort()).toEqual(
      siblings.map((id) => email(id).eventKey).sort(),
    );
    expect(
      (await AppointmentReminderModel.find({}).lean()).map((row) => String(row.bookingId)).sort(),
    ).toEqual(siblings.map(String).sort());
  });

  it("rolls back earlier sibling intents when later work fails", async () => {
    await expect(
      transaction(async (session) => {
        for (const id of [new Types.ObjectId(), new Types.ObjectId()]) {
          await emails.enqueue(email(id), session);
          await reminders.schedule(reminder(id), session);
        }
        throw new Error("later sibling failed");
      }),
    ).rejects.toThrow("later sibling failed");
    expect(await EmailOutboxModel.countDocuments({})).toBe(0);
    expect(await AppointmentReminderModel.countDocuments({})).toBe(0);
  });

  it("reuses an existing reminder without changing its schedule or terminal late decision", async () => {
    const input = { ...reminder(new Types.ObjectId()), scheduleStartAt: now };
    const original = await reminders.schedule(input);
    await transaction(async (session) => {
      const duplicate = await reminders.schedule(input, session);
      expect(duplicate.created).toBe(false);
      expect(duplicate.record._id.equals(original.record._id)).toBe(true);
      expect(duplicate.record.status).toBe("SKIPPED");
    });
    expect(await AppointmentReminderModel.countDocuments({})).toBe(1);
  });

  it("deduplicates rows already inserted earlier in the same transaction", async () => {
    const id = new Types.ObjectId();
    await transaction(async (session) => {
      const firstEmail = await emails.enqueue(email(id), session);
      const firstReminder = await reminders.schedule(reminder(id), session);
      const nextEmail = await emails.enqueue(email(id), session);
      const nextReminder = await reminders.schedule(reminder(id), session);
      expect(nextEmail.created).toBe(false);
      expect(nextReminder.created).toBe(false);
      expect(nextEmail.record._id.equals(firstEmail.record._id)).toBe(true);
      expect(nextReminder.record._id.equals(firstReminder.record._id)).toBe(true);
    });
    expect(await EmailOutboxModel.countDocuments({})).toBe(1);
    expect(await AppointmentReminderModel.countDocuments({})).toBe(1);
  });

  it("rejects inactive supplied sessions before either repository can write", async () => {
    const session = await mongoose.startSession();
    try {
      const id = new Types.ObjectId();
      await expect(emails.enqueue(email(id), session)).rejects.toThrow("active caller transaction");
      await expect(reminders.schedule(reminder(id), session)).rejects.toThrow(
        "active caller transaction",
      );
      expect(await EmailOutboxModel.countDocuments({})).toBe(0);
      expect(await AppointmentReminderModel.countDocuments({})).toBe(0);
    } finally {
      await session.endSession();
    }
  });

  it.each(["email", "reminder"] as const)(
    "%s propagates a real transactional 11000 without an out-of-session fallback",
    async (kind) => {
      const id = new Types.ObjectId();
      // A deterministic read barrier exposes the actual unique-index error. No fabricated
      // server label or synthetic duplicate exception is used.
      if (kind === "email") await emails.enqueue(email(id));
      else await reminders.schedule(reminder(id));
      const emptyEmail = EmailOutboxModel.findOne();
      const emptyReminder = AppointmentReminderModel.findOne();
      vi.spyOn(emptyEmail, "exec").mockResolvedValueOnce(null);
      vi.spyOn(emptyReminder, "exec").mockResolvedValueOnce(null);
      const emailRead = vi.spyOn(EmailOutboxModel, "findOne").mockReturnValueOnce(emptyEmail);
      const reminderRead = vi
        .spyOn(AppointmentReminderModel, "findOne")
        .mockReturnValueOnce(emptyReminder);
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        const write =
          kind === "email"
            ? emails.enqueue(email(id), session)
            : reminders.schedule(reminder(id), session);
        await expect(write).rejects.toMatchObject({ code: 11000 });
        expect(emailRead).toHaveBeenCalledTimes(kind === "email" ? 1 : 0);
        expect(reminderRead).toHaveBeenCalledTimes(kind === "reminder" ? 1 : 0);
        await session.abortTransaction();
      } finally {
        emailRead.mockRestore();
        reminderRead.mockRestore();
        await session.endSession();
      }
      expect(await EmailOutboxModel.countDocuments({})).toBe(kind === "email" ? 1 : 0);
      expect(await AppointmentReminderModel.countDocuments({})).toBe(kind === "reminder" ? 1 : 0);
    },
  );
});
