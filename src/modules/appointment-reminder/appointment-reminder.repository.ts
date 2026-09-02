import { Types } from "mongoose";

import {
  type AppointmentReminderDocument,
  AppointmentReminderModel,
} from "./appointment-reminder.model.js";
import {
  type AppointmentReminderChannelDecision,
  type AppointmentReminderKind,
  buildAppointmentReminderDedupeKey,
  computeAppointmentReminderDueAt,
} from "./appointment-reminder.types.js";

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === 11000;

export type ReminderChannel = "email" | "sms";

export type ScheduleReminderInput = {
  kind: AppointmentReminderKind;
  bookingId: Types.ObjectId;
  businessId: Types.ObjectId;
  customerUserId: Types.ObjectId;
  scheduleStartAt: Date;
  /** Absolute instant used for the `dueAt <= now` late-booking decision. */
  now: Date;
};

export type ScheduleReminderResult = {
  /** false when a row for this exact logical identity already existed. */
  created: boolean;
  record: AppointmentReminderDocument;
};

export type ClaimReminderOptions = {
  workerId: string;
  now: Date;
  claimTimeoutMs: number;
  maxAttempts: number;
};

const CHANNEL_FIELDS: Record<
  ReminderChannel,
  {
    decision: "emailDecision" | "smsDecision";
    dedupe: "emailOutboxDedupeKey" | "smsOutboxDedupeKey";
    recipient: "emailRecipient" | "smsRecipientE164";
  }
> = {
  email: {
    decision: "emailDecision",
    dedupe: "emailOutboxDedupeKey",
    recipient: "emailRecipient",
  },
  sms: { decision: "smsDecision", dedupe: "smsOutboxDedupeKey", recipient: "smsRecipientE164" },
};

const otherChannel = (channel: ReminderChannel): ReminderChannel =>
  channel === "email" ? "sms" : "email";

export class AppointmentReminderRepository {
  /**
   * Idempotent create for one logical reminder. If the appointment is already inside the offset
   * window (`dueAt <= now`) the row is persisted directly in terminal `SKIPPED` — never as a
   * PENDING row that would fire an immediate "24-hour" reminder. A duplicate scheduling call
   * (same `dedupeKey`) is a no-op that returns the existing row.
   */
  public async schedule(input: ScheduleReminderInput): Promise<ScheduleReminderResult> {
    const dedupeKey = buildAppointmentReminderDedupeKey(
      input.kind,
      String(input.bookingId),
      input.scheduleStartAt,
    );
    const dueAt = computeAppointmentReminderDueAt(input.scheduleStartAt, input.kind);
    const isLate = dueAt.getTime() <= input.now.getTime();
    const channelDecision = isLate ? "SKIPPED_INELIGIBLE" : "PENDING";

    try {
      const record = await AppointmentReminderModel.create({
        dedupeKey,
        kind: input.kind,
        bookingId: input.bookingId,
        businessId: input.businessId,
        customerUserId: input.customerUserId,
        offsetMinutes: Math.round((input.scheduleStartAt.getTime() - dueAt.getTime()) / 60_000),
        scheduleStartAt: input.scheduleStartAt,
        dueAt,
        status: isLate ? "SKIPPED" : "PENDING",
        attemptCount: 0,
        emailDecision: channelDecision,
        smsDecision: channelDecision,
        ...(isLate ? { processedAt: input.now, lastErrorCategory: "CREATED_INSIDE_WINDOW" } : {}),
      });
      return { created: true, record };
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      const existing = await AppointmentReminderModel.findOne({ dedupeKey }).orFail();
      return { created: false, record: existing };
    }
  }

  public findByDedupeKey(dedupeKey: string): Promise<AppointmentReminderDocument | null> {
    return AppointmentReminderModel.findOne({ dedupeKey }).exec();
  }

  public findActiveByBookingId(
    bookingId: Types.ObjectId | string,
  ): Promise<AppointmentReminderDocument[]> {
    return AppointmentReminderModel.find({
      bookingId,
      status: { $in: ["PENDING", "PROCESSING"] },
    }).exec();
  }

  /**
   * Retire every still-active reminder for a booking — used when the booking is cancelled /
   * completed / marked no-show, and (with `exceptDedupeKey`) when a reschedule supersedes the
   * old schedule version. **No claim-token guard — a booking lifecycle transition is
   * authoritative and overrides any worker's ownership.** `COMPLETED` / `SKIPPED` /
   * already-`CANCELLED` rows are immutable and left untouched. Returns how many rows were retired.
   */
  public async retireActiveForBooking(
    bookingId: Types.ObjectId | string,
    reasonCategory: string,
    options: { now: Date; exceptDedupeKey?: string | undefined } = { now: new Date() },
  ): Promise<number> {
    const filter: Record<string, unknown> = {
      bookingId,
      status: { $in: ["PENDING", "PROCESSING"] },
    };
    if (options.exceptDedupeKey) {
      filter["dedupeKey"] = { $ne: options.exceptDedupeKey };
    }

    const result = await AppointmentReminderModel.updateMany(filter, {
      $set: {
        status: "CANCELLED",
        processedAt: options.now,
        lastErrorCategory: reasonCategory,
      },
      $unset: { claimedAt: "", claimedBy: "" },
    }).exec();

    return result.modifiedCount ?? 0;
  }

  /**
   * Account-closure cleanup — retire every still-active reminder for this customer, across any
   * booking. Same authoritative-override semantics as `retireActiveForBooking` (no claim-token
   * guard; `COMPLETED` / `SKIPPED` / already-`CANCELLED` rows are left untouched). Normally a
   * defensive no-op, since account closure is blocked while upcoming bookings exist. Returns how
   * many rows were retired.
   */
  public async retireActiveForCustomer(
    customerUserId: Types.ObjectId | string,
    reasonCategory: string,
    options: { now: Date } = { now: new Date() },
  ): Promise<number> {
    const result = await AppointmentReminderModel.updateMany(
      { customerUserId, status: { $in: ["PENDING", "PROCESSING"] } },
      {
        $set: {
          status: "CANCELLED",
          processedAt: options.now,
          lastErrorCategory: reasonCategory,
        },
        $unset: { claimedAt: "", claimedBy: "" },
      },
    ).exec();

    return result.modifiedCount ?? 0;
  }

  /**
   * Atomically move ONE due reminder to PROCESSING and return it (`null` when none). Eligible =
   * PENDING and due, OR PROCESSING with a stale claim — in both cases only while attempts remain.
   * `attemptCount` is incremented in the same write, so a crash mid-process still burns one.
   *
   * `claimedBy` is set to a **per-claim UNIQUE token** (`"<workerId>:<ObjectId>"`), returned on
   * the row — the caller must thread `record.claimedBy` verbatim into every subsequent processing
   * write so a stale worker whose claim was reclaimed can no longer mutate the row.
   */
  public claimNext(options: ClaimReminderOptions): Promise<AppointmentReminderDocument | null> {
    const staleBefore = new Date(options.now.getTime() - options.claimTimeoutMs);
    const claimToken = `${options.workerId}:${new Types.ObjectId().toHexString()}`;

    return AppointmentReminderModel.findOneAndUpdate(
      {
        attemptCount: { $lt: options.maxAttempts },
        $or: [
          { status: "PENDING", dueAt: { $lte: options.now } },
          { status: "PROCESSING", claimedAt: { $lte: staleBefore } },
        ],
      },
      {
        $set: { status: "PROCESSING", claimedAt: options.now, claimedBy: claimToken },
        $inc: { attemptCount: 1 },
      },
      { returnDocument: "after", sort: { dueAt: 1 } },
    ).exec();
  }

  /** Explicit sweep so a run can start from a clean state (claimNext also self-reclaims). */
  public async resetStaleProcessing(staleBefore: Date): Promise<number> {
    const result = await AppointmentReminderModel.updateMany(
      { status: "PROCESSING", claimedAt: { $lte: staleBefore } },
      { $set: { status: "PENDING" }, $unset: { claimedAt: "", claimedBy: "" } },
    ).exec();
    return result.modifiedCount ?? 0;
  }

  /**
   * FROZEN set-once recipient for a channel. Guarded on `{_id, status:"PROCESSING", claimedBy}`
   * (ownership fence). `$ifNull` keeps any already-frozen value — a legitimate replay is a
   * harmless no-op that returns the row carrying the frozen value. Returns `null` ONLY when the
   * ownership/status guard fails (row reclaimed by another worker, or retired to CANCELLED /
   * COMPLETED) — the caller must then stop mutating this reminder.
   */
  public freezeChannelRecipient(
    id: Types.ObjectId,
    claimToken: string,
    input: { channel: ReminderChannel; recipient: string },
  ): Promise<AppointmentReminderDocument | null> {
    const field = CHANNEL_FIELDS[input.channel].recipient;
    return AppointmentReminderModel.findOneAndUpdate(
      { _id: id, status: "PROCESSING", claimedBy: claimToken },
      [{ $set: { [field]: { $ifNull: [`$${field}`, input.recipient] } } }],
      { returnDocument: "after", updatePipeline: true },
    ).exec();
  }

  /**
   * Records ONE channel's FINAL orchestration decision. Guarded on `{_id, status:"PROCESSING",
   * claimedBy, <channel>Decision:"PENDING"}`:
   *  - ownership fence (`claimedBy`) — a stale worker cannot write.
   *  - immutability fence (`<channel>Decision:"PENDING"`) — a final decision never changes; a
   *    duplicate/replayed call matches 0 rows and is a safe no-op.
   * When the OTHER channel is already final, this same atomic write also flips the row to
   * `COMPLETED` (+ `processedAt`, clears the claim). Never marks COMPLETED early.
   * Returns `null` when the guard fails (already final, reclaimed, or retired).
   */
  public recordChannelDecision(
    id: Types.ObjectId,
    claimToken: string,
    input: {
      channel: ReminderChannel;
      decision: Exclude<AppointmentReminderChannelDecision, "PENDING">;
      outboxDedupeKey?: string | undefined;
      now: Date;
    },
  ): Promise<AppointmentReminderDocument | null> {
    const fields = CHANNEL_FIELDS[input.channel];
    const otherDecisionField = CHANNEL_FIELDS[otherChannel(input.channel)].decision;
    // Evaluated against the PRE-stage document → "is the OTHER channel already final".
    const otherFinal = {
      $ne: [{ $ifNull: [`$${otherDecisionField}`, "PENDING"] }, "PENDING"],
    };

    return AppointmentReminderModel.findOneAndUpdate(
      { _id: id, status: "PROCESSING", claimedBy: claimToken, [fields.decision]: "PENDING" },
      [
        {
          $set: {
            [fields.decision]: input.decision,
            ...(input.outboxDedupeKey ? { [fields.dedupe]: input.outboxDedupeKey } : {}),
            status: { $cond: [otherFinal, "COMPLETED", "$status"] },
            processedAt: { $cond: [otherFinal, input.now, "$processedAt"] },
            claimedAt: { $cond: [otherFinal, "$$REMOVE", "$claimedAt"] },
            claimedBy: { $cond: [otherFinal, "$$REMOVE", "$claimedBy"] },
          },
        },
      ],
      { returnDocument: "after", updatePipeline: true },
    ).exec();
  }

  /**
   * Whole-reminder skip — used ONLY when the booking is ineligible BEFORE any channel has been
   * dispatched. Force-sets both channel decisions to `SKIPPED_INELIGIBLE`. Ownership-guarded.
   */
  public markSkipped(
    id: Types.ObjectId,
    claimToken: string,
    input: { reasonCategory: string; now: Date },
  ): Promise<AppointmentReminderDocument | null> {
    return AppointmentReminderModel.findOneAndUpdate(
      { _id: id, status: "PROCESSING", claimedBy: claimToken },
      {
        $set: {
          status: "SKIPPED",
          emailDecision: "SKIPPED_INELIGIBLE",
          smsDecision: "SKIPPED_INELIGIBLE",
          processedAt: input.now,
          lastErrorCategory: input.reasonCategory,
        },
        $unset: { claimedAt: "", claimedBy: "" },
      },
      { returnDocument: "after" },
    ).exec();
  }

  /**
   * A channel is still `PENDING` after an infra failure: back to `PENDING` for another pass
   * while attempts remain, else terminal `FAILED`. Ownership-guarded. **Never touches
   * `emailDecision` / `smsDecision` / `emailRecipient` / `smsRecipientE164` /
   * `emailOutboxDedupeKey` / `smsOutboxDedupeKey`** — an already-resolved channel's progress
   * (including a live outbox row) survives the retry and any eventual FAILED.
   */
  public releaseForRetryOrFail(
    id: Types.ObjectId,
    claimToken: string,
    input: { category: string; message: string; attemptsExhausted: boolean; now: Date },
  ): Promise<AppointmentReminderDocument | null> {
    return AppointmentReminderModel.findOneAndUpdate(
      { _id: id, status: "PROCESSING", claimedBy: claimToken },
      {
        $set: {
          status: input.attemptsExhausted ? "FAILED" : "PENDING",
          lastErrorCategory: input.category,
          lastErrorMessage: input.message.slice(0, 500),
          ...(input.attemptsExhausted ? { processedAt: input.now } : {}),
        },
        $unset: { claimedAt: "", claimedBy: "" },
      },
      { returnDocument: "after" },
    ).exec();
  }
}
