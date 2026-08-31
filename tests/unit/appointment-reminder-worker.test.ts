import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";

import type { AppointmentReminderDocument } from "../../src/modules/appointment-reminder/appointment-reminder.model.js";
import { AppointmentReminderWorker } from "../../src/modules/appointment-reminder/appointment-reminder.worker.js";
import { CustomerNotificationPolicy } from "../../src/modules/notification/customer-notification-policy.js";

const NOW = new Date("2026-09-09T09:00:00.000Z");
const START = new Date("2026-09-10T09:00:00.000Z"); // 24h after NOW
const TOKEN = "appointment-reminder-1:aaaaaaaaaaaaaaaaaaaaaaaa";

const makeReminder = (
  overrides: Partial<AppointmentReminderDocument> = {},
): AppointmentReminderDocument =>
  ({
    _id: new Types.ObjectId(),
    dedupeKey: `APPOINTMENT_REMINDER_24H:650000000000000000000001:${START.getTime()}`,
    bookingId: new Types.ObjectId("650000000000000000000001"),
    customerUserId: new Types.ObjectId("650000000000000000000009"),
    scheduleStartAt: START,
    dueAt: new Date(START.getTime() - 24 * 60 * 60 * 1000),
    status: "PROCESSING",
    attemptCount: 1,
    claimedBy: TOKEN,
    emailDecision: "PENDING",
    smsDecision: "PENDING",
    ...overrides,
  }) as unknown as AppointmentReminderDocument;

const makeBooking = (overrides: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId("650000000000000000000001"),
  businessId: new Types.ObjectId("650000000000000000000002"),
  status: "UPCOMING",
  schedule: {
    startAt: START,
    endAt: new Date(START.getTime() + 3_600_000),
    timezone: "Europe/Nicosia",
  },
  reference: "BK-TEST01",
  serviceLines: [{ serviceSnapshot: { name: "Haircut", durationMin: 30 } }],
  fulfilment: { mode: "AT_BUSINESS_LOCATION" },
  customer: { contact: { firstName: "Jane", normalizedEmail: "snapshot@old.example" } },
  ...overrides,
});

/** A repository mock whose channel-decision / freeze / skip / release writes SUCCEED (return a
 * truthy doc) and record their calls. Pass `ownershipLost: <method>` to make one method return
 * null (guard failed). */
type MockFn = ReturnType<typeof vi.fn>;
type RepoMock = Record<
  | "resetStaleProcessing"
  | "claimNext"
  | "freezeChannelRecipient"
  | "recordChannelDecision"
  | "markSkipped"
  | "releaseForRetryOrFail",
  MockFn
>;

const buildRepo = (opts: { ownershipLost?: string } = {}): RepoMock => {
  const ok = (name: string) =>
    vi
      .fn()
      .mockImplementation(async () =>
        opts.ownershipLost === name ? null : { _id: "x", status: "PROCESSING" },
      );
  return {
    resetStaleProcessing: vi.fn().mockResolvedValue(0),
    claimNext: vi.fn(),
    freezeChannelRecipient: vi.fn().mockImplementation(async (_id, _t, input) =>
      opts.ownershipLost === "freezeChannelRecipient"
        ? null
        : {
            emailRecipient: input.channel === "email" ? input.recipient : undefined,
            smsRecipientE164: input.channel === "sms" ? input.recipient : undefined,
          },
    ),
    recordChannelDecision: ok("recordChannelDecision"),
    markSkipped: ok("markSkipped"),
    releaseForRetryOrFail: ok("releaseForRetryOrFail"),
  };
};

const build = (opts: {
  booking?: unknown;
  business?: unknown;
  profile?: unknown;
  user?: unknown;
  smsConfigured?: boolean;
  emailEnqueue?: MockFn;
  smsEnqueue?: MockFn;
  repo?: RepoMock;
}) => {
  const repository = opts.repo ?? buildRepo();
  const bookingRepository = {
    findByIdOnly: vi.fn().mockResolvedValue("booking" in opts ? opts.booking : makeBooking()),
  };
  const businessRepository = {
    findById: vi
      .fn()
      .mockResolvedValue(
        "business" in opts ? opts.business : { _id: new Types.ObjectId(), name: "Glow Studio" },
      ),
  };
  const userRepository = {
    findById: vi
      .fn()
      .mockResolvedValue(
        "user" in opts
          ? opts.user
          : { normalizedEmail: "current@account.example", phoneVerifiedAt: new Date() },
      ),
    findProfileByUserId: vi.fn().mockResolvedValue("profile" in opts ? opts.profile : {}),
  };
  const emailOutbox = {
    enqueue:
      opts.emailEnqueue ??
      vi.fn().mockResolvedValue({ created: true, record: { dedupeKey: "EMAIL_KEY" } }),
  };
  const smsOutbox = {
    enqueue:
      opts.smsEnqueue ??
      vi.fn().mockResolvedValue({ created: true, record: { dedupeKey: "SMS_KEY" } }),
  };
  const smsTransport = { isConfigured: () => opts.smsConfigured ?? true };

  const worker = new AppointmentReminderWorker(
    repository as never,
    bookingRepository as never,
    businessRepository as never,
    userRepository as never,
    new CustomerNotificationPolicy(),
    emailOutbox as never,
    smsOutbox as never,
    smsTransport as never,
    {
      workerId: "appointment-reminder-1",
      batchSize: 10,
      concurrency: 2,
      maxAttempts: 5,
      claimTimeoutMs: 120_000,
    },
    () => NOW,
  );
  return {
    worker,
    repository,
    bookingRepository,
    businessRepository,
    userRepository,
    emailOutbox,
    smsOutbox,
  };
};

const lastDecision = (repo: RepoMock, channel: "email" | "sms") =>
  repo.recordChannelDecision.mock.calls
    .map((call) => call[2] as { channel: string; decision: string })
    .filter((d) => d.channel === channel)
    .pop();

describe("AppointmentReminderWorker.processOne — channel matrix", () => {
  it("A: Email ON, SMS OFF → email ENQUEUED, sms SUPPRESSED_BY_PREFERENCE, COMPLETED", async () => {
    const repo = buildRepo();
    const h = build({ repo, profile: { notifications: { appointmentReminderSms: false } } });
    const r = await h.worker.processOne(makeReminder());

    expect(r.status).toBe("completed");
    expect(h.emailOutbox.enqueue).toHaveBeenCalledTimes(1);
    expect(h.smsOutbox.enqueue).not.toHaveBeenCalled();
    expect(lastDecision(repo, "email")?.decision).toBe("ENQUEUED");
    expect(lastDecision(repo, "sms")?.decision).toBe("SUPPRESSED_BY_PREFERENCE");
  });

  it("B: Email OFF, SMS ON + verified + configured → email SUPPRESSED, sms ENQUEUED, COMPLETED", async () => {
    const repo = buildRepo();
    const h = build({
      repo,
      profile: {
        notifications: { appointmentReminderEmail: false, appointmentReminderSms: true },
        phone: { e164: "+35799123456" },
      },
    });
    const r = await h.worker.processOne(makeReminder());

    expect(r.status).toBe("completed");
    expect(h.emailOutbox.enqueue).not.toHaveBeenCalled();
    expect(h.smsOutbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: `${makeReminder().dedupeKey}:sms`,
        recipientE164: "+35799123456",
        body: expect.stringContaining("Glow Studio"),
      }),
    );
    expect(lastDecision(repo, "email")?.decision).toBe("SUPPRESSED_BY_PREFERENCE");
    expect(lastDecision(repo, "sms")?.decision).toBe("ENQUEUED");
  });

  it("C: Both ON + verified + configured → both ENQUEUED, COMPLETED, one between-channel re-read", async () => {
    const repo = buildRepo();
    const h = build({
      repo,
      profile: {
        notifications: { appointmentReminderEmail: true, appointmentReminderSms: true },
        phone: { e164: "+35799123456" },
      },
    });
    const r = await h.worker.processOne(makeReminder());

    expect(r.status).toBe("completed");
    expect(h.emailOutbox.enqueue).toHaveBeenCalledTimes(1);
    expect(h.smsOutbox.enqueue).toHaveBeenCalledTimes(1);
    // 1 initial eligibility read + 1 between-channel re-read
    expect(h.bookingRepository.findByIdOnly).toHaveBeenCalledTimes(2);
    expect(lastDecision(repo, "email")?.decision).toBe("ENQUEUED");
    expect(lastDecision(repo, "sms")?.decision).toBe("ENQUEUED");
  });

  it("D: Both OFF → both SUPPRESSED, COMPLETED, only 2 reads (booking + profile)", async () => {
    const repo = buildRepo();
    const h = build({
      repo,
      profile: {
        notifications: { appointmentReminderEmail: false, appointmentReminderSms: false },
      },
    });
    const r = await h.worker.processOne(makeReminder());

    expect(r.status).toBe("completed");
    expect(h.emailOutbox.enqueue).not.toHaveBeenCalled();
    expect(h.smsOutbox.enqueue).not.toHaveBeenCalled();
    expect(h.userRepository.findById).not.toHaveBeenCalled();
    expect(h.businessRepository.findById).not.toHaveBeenCalled();
    expect(lastDecision(repo, "email")?.decision).toBe("SUPPRESSED_BY_PREFERENCE");
    expect(lastDecision(repo, "sms")?.decision).toBe("SUPPRESSED_BY_PREFERENCE");
  });

  it("E: SMS ON but no verified phone → SKIPPED_NO_VERIFIED_PHONE (not SUPPRESSED)", async () => {
    const repo = buildRepo();
    const h = build({
      repo,
      profile: {
        notifications: { appointmentReminderEmail: false, appointmentReminderSms: true },
      },
      user: { phoneVerifiedAt: undefined },
    });
    await h.worker.processOne(makeReminder());
    expect(h.smsOutbox.enqueue).not.toHaveBeenCalled();
    expect(lastDecision(repo, "sms")?.decision).toBe("SKIPPED_NO_VERIFIED_PHONE");
  });

  it("F: SMS ON + verified but Twilio not configured → SKIPPED_PROVIDER_NOT_CONFIGURED, no outbox row", async () => {
    const repo = buildRepo();
    const h = build({
      repo,
      smsConfigured: false,
      profile: {
        notifications: { appointmentReminderEmail: false, appointmentReminderSms: true },
        phone: { e164: "+35799123456" },
      },
    });
    await h.worker.processOne(makeReminder());
    expect(h.smsOutbox.enqueue).not.toHaveBeenCalled();
    expect(lastDecision(repo, "sms")?.decision).toBe("SKIPPED_PROVIDER_NOT_CONFIGURED");
  });

  it("G: legacy profile (no notifications sub-doc) → email default ON (ENQUEUED), sms default OFF (SUPPRESSED)", async () => {
    const repo = buildRepo();
    const h = build({ repo, profile: {} });
    const r = await h.worker.processOne(makeReminder());
    expect(r.status).toBe("completed");
    expect(lastDecision(repo, "email")?.decision).toBe("ENQUEUED");
    expect(lastDecision(repo, "sms")?.decision).toBe("SUPPRESSED_BY_PREFERENCE");
  });
});

describe("AppointmentReminderWorker.processOne — partial failure & retry", () => {
  it("email success + SMS infra fail → email ENQUEUED persisted, reminder retried", async () => {
    const repo = buildRepo();
    const h = build({
      repo,
      profile: {
        notifications: { appointmentReminderEmail: true, appointmentReminderSms: true },
        phone: { e164: "+35799123456" },
      },
      smsEnqueue: vi.fn().mockRejectedValue(new Error("sms outbox DB down")),
    });
    const r = await h.worker.processOne(makeReminder({ attemptCount: 1 }));

    expect(r.status).toBe("retried");
    expect(r.email).toBe("enqueued");
    expect(lastDecision(repo, "email")?.decision).toBe("ENQUEUED");
    expect(repo.releaseForRetryOrFail).toHaveBeenCalledWith(
      expect.anything(),
      TOKEN,
      expect.objectContaining({ category: "SMS_INFRA_ERROR", attemptsExhausted: false }),
    );
  });

  it("SMS success + email infra fail (same attempt) → sms ENQUEUED persisted, reminder retried", async () => {
    const repo = buildRepo();
    const h = build({
      repo,
      profile: {
        notifications: { appointmentReminderEmail: true, appointmentReminderSms: true },
        phone: { e164: "+35799123456" },
      },
      emailEnqueue: vi.fn().mockRejectedValue(new Error("email outbox DB down")),
    });
    const r = await h.worker.processOne(makeReminder());

    expect(r.status).toBe("retried");
    expect(r.sms).toBe("enqueued"); // email failure did NOT block SMS
    expect(lastDecision(repo, "sms")?.decision).toBe("ENQUEUED");
    expect(repo.releaseForRetryOrFail).toHaveBeenCalledWith(
      expect.anything(),
      TOKEN,
      expect.objectContaining({ category: "EMAIL_INFRA_ERROR" }),
    );
  });

  it("retry with email already ENQUEUED → email branch skipped, only SMS resolved", async () => {
    const repo = buildRepo();
    const h = build({
      repo,
      profile: {
        notifications: { appointmentReminderSms: false },
      },
    });
    await h.worker.processOne(makeReminder({ emailDecision: "ENQUEUED", emailRecipient: "x@y.z" }));
    expect(h.emailOutbox.enqueue).not.toHaveBeenCalled();
    expect(lastDecision(repo, "sms")?.decision).toBe("SUPPRESSED_BY_PREFERENCE");
  });

  it("infra failure at maxAttempts → FAILED, already-final channel preserved", async () => {
    const repo = buildRepo();
    const h = build({
      repo,
      profile: {
        notifications: { appointmentReminderEmail: true, appointmentReminderSms: true },
        phone: { e164: "+35799123456" },
      },
      smsEnqueue: vi.fn().mockRejectedValue(new Error("still down")),
    });
    const r = await h.worker.processOne(makeReminder({ attemptCount: 5 }));
    expect(r.status).toBe("failed");
    expect(repo.releaseForRetryOrFail).toHaveBeenCalledWith(
      expect.anything(),
      TOKEN,
      expect.objectContaining({ attemptsExhausted: true }),
    );
  });
});

describe("AppointmentReminderWorker.processOne — recipient freeze", () => {
  it("freezes emailRecipient before the EmailOutbox enqueue", async () => {
    const repo = buildRepo();
    const h = build({ repo, profile: { notifications: { appointmentReminderSms: false } } });
    await h.worker.processOne(makeReminder());
    expect(repo.freezeChannelRecipient).toHaveBeenCalledWith(
      expect.anything(),
      TOKEN,
      expect.objectContaining({ channel: "email", recipient: "current@account.example" }),
    );
    // enqueue used the frozen value
    expect(h.emailOutbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: "current@account.example" }),
    );
  });

  it("retry with emailRecipient already frozen → does NOT re-resolve, re-enqueues with frozen value", async () => {
    const repo = buildRepo();
    const h = build({
      repo,
      profile: { notifications: { appointmentReminderSms: false } },
      user: { normalizedEmail: "NEW@account.example", phoneVerifiedAt: new Date() },
    });
    await h.worker.processOne(makeReminder({ emailRecipient: "frozen-old@account.example" }));
    expect(repo.freezeChannelRecipient).not.toHaveBeenCalledWith(
      expect.anything(),
      TOKEN,
      expect.objectContaining({ channel: "email" }),
    );
    expect(h.emailOutbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: "frozen-old@account.example" }),
    );
  });

  it("retry with smsRecipientE164 already frozen → uses frozen phone even though profile phone changed", async () => {
    const repo = buildRepo();
    const h = build({
      repo,
      profile: {
        notifications: { appointmentReminderEmail: false, appointmentReminderSms: true },
        phone: { e164: "+35799999999" }, // changed
      },
      user: { phoneVerifiedAt: new Date() },
    });
    await h.worker.processOne(makeReminder({ smsRecipientE164: "+35799123456" }));
    expect(h.smsOutbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ recipientE164: "+35799123456" }),
    );
  });
});

describe("AppointmentReminderWorker.processOne — ownership fence & eligibility", () => {
  it("stale token: recordChannelDecision guard fails → stops, status ownership_lost", async () => {
    const repo = buildRepo({ ownershipLost: "recordChannelDecision" });
    const h = build({ repo, profile: { notifications: { appointmentReminderSms: false } } });
    const r = await h.worker.processOne(makeReminder());
    expect(r.status).toBe("ownership_lost");
  });

  it("stale token: freezeChannelRecipient guard fails → stops", async () => {
    const repo = buildRepo({ ownershipLost: "freezeChannelRecipient" });
    const h = build({ repo, profile: { notifications: { appointmentReminderSms: false } } });
    const r = await h.worker.processOne(makeReminder());
    expect(r.status).toBe("ownership_lost");
    expect(h.emailOutbox.enqueue).not.toHaveBeenCalled();
  });

  it("whole-reminder skip when booking is cancelled before any channel dispatched", async () => {
    const repo = buildRepo();
    const h = build({ repo, booking: makeBooking({ status: "CANCELLED_BY_CUSTOMER" }) });
    const r = await h.worker.processOne(makeReminder());
    expect(r.status).toBe("skipped");
    expect(repo.markSkipped).toHaveBeenCalledWith(
      expect.anything(),
      TOKEN,
      expect.objectContaining({ reasonCategory: "BOOKING_CANCELLED_BY_CUSTOMER" }),
    );
  });

  it("between-channel: booking cancelled after email enqueue → SMS SKIPPED_INELIGIBLE, COMPLETED", async () => {
    const repo = buildRepo();
    const h = build({
      repo,
      profile: {
        notifications: { appointmentReminderEmail: true, appointmentReminderSms: true },
        phone: { e164: "+35799123456" },
      },
    });
    // first booking read = eligible; between-channel read = cancelled
    h.bookingRepository.findByIdOnly
      .mockResolvedValueOnce(makeBooking())
      .mockResolvedValueOnce(makeBooking({ status: "CANCELLED_BY_CUSTOMER" }));

    const r = await h.worker.processOne(makeReminder());
    expect(r.status).toBe("completed");
    expect(r.email).toBe("enqueued");
    expect(h.smsOutbox.enqueue).not.toHaveBeenCalled();
    expect(lastDecision(repo, "sms")?.decision).toBe("SKIPPED_INELIGIBLE");
  });

  it("schedule moved between channels → SMS SKIPPED_INELIGIBLE (no stale-time SMS)", async () => {
    const repo = buildRepo();
    const h = build({
      repo,
      profile: {
        notifications: { appointmentReminderEmail: true, appointmentReminderSms: true },
        phone: { e164: "+35799123456" },
      },
    });
    h.bookingRepository.findByIdOnly.mockResolvedValueOnce(makeBooking()).mockResolvedValueOnce(
      makeBooking({
        schedule: {
          startAt: new Date(START.getTime() + 48 * 3_600_000),
          endAt: new Date(START.getTime() + 49 * 3_600_000),
          timezone: "Europe/Nicosia",
        },
      }),
    );
    const r = await h.worker.processOne(makeReminder());
    expect(h.smsOutbox.enqueue).not.toHaveBeenCalled();
    expect(lastDecision(repo, "sms")?.decision).toBe("SKIPPED_INELIGIBLE");
    expect(r.status).toBe("completed");
  });
});
