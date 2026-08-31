import { logger } from "../../config/logger.js";
import type { BookingDocument } from "../booking/booking.model.js";
import type { BookingRepository } from "../booking/booking.repository.js";
import type { BusinessRepository } from "../business/business.repository.js";
import { buildAppointmentReminderEmailData } from "../email/templates/booking/appointment-reminder-24h.template.js";
import {
  formatDateInTimezone,
  formatTimeInTimezone,
} from "../email/templates/components/email-format.js";
import type { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import type { CustomerNotificationPolicy } from "../notification/customer-notification-policy.js";
import { buildAppointmentReminderSmsMessage } from "../sms/appointment-reminder-sms-message.js";
import type { SmsTransport } from "../sms/sms-transport.js";
import { maskPhone } from "../sms/sms-transport.js";
import type { SmsOutboxService } from "../sms-outbox/sms-outbox.service.js";
import type { UserRepository } from "../user/user.repository.js";
import { resolveNotificationPreferences } from "../user/user.types.js";
import type { AppointmentReminderDocument } from "./appointment-reminder.model.js";
import type { AppointmentReminderRepository } from "./appointment-reminder.repository.js";
import { isFinalChannelDecision } from "./appointment-reminder.types.js";

export type AppointmentReminderWorkerOptions = {
  workerId: string;
  batchSize: number;
  concurrency: number;
  /** Orchestration attempts (NOT provider retries — the outboxes own those). */
  maxAttempts: number;
  claimTimeoutMs: number;
};

export type AppointmentReminderPassCounts = {
  claimed: number;
  recoveredStale: number;
  completed: number;
  retried: number;
  failed: number;
  skipped: number;
  ownershipLost: number;
  emailEnqueued: number;
  emailSuppressed: number;
  emailSkippedNoRecipient: number;
  emailPendingInfraError: number;
  smsEnqueued: number;
  smsSuppressed: number;
  smsSkippedNoVerifiedPhone: number;
  smsSkippedProviderNotConfigured: number;
  smsSkippedIneligibleBetweenChannels: number;
  smsPendingInfraError: number;
  failedWithPartialDispatch: number;
  failedNoDispatch: number;
};

type ChannelOutcome =
  | "already_final"
  | "enqueued"
  | "suppressed_by_preference"
  | "skipped_no_recipient"
  | "skipped_no_verified_phone"
  | "skipped_provider_not_configured"
  | "skipped_ineligible"
  | "pending_infra_error";

type ReminderProcessResult = {
  status: "completed" | "skipped" | "retried" | "failed" | "ownership_lost";
  email: ChannelOutcome;
  sms: ChannelOutcome;
};

const TERMINAL_BOOKING_STATUSES = new Set([
  "COMPLETED",
  "PENDING",
  "NO_SHOW_CHARGED",
  "NO_SHOW_WAIVED",
  "NO_SHOW_CANCELLED",
  "CANCELLED_BY_CUSTOMER",
  "CANCELLED_BY_BUSINESS",
  "LATE_CANCELLATION",
]);

const safeMessage = (error: unknown): string =>
  error instanceof Error ? error.name : "unknown error";

/** Sentinel a channel step returns when the ownership/status guard matched zero rows — the
 * reminder was reclaimed by another worker or retired by a booking lifecycle transition. */
const OWNERSHIP_LOST = Symbol("ownership-lost");

/**
 * Multi-channel 24h reminder orchestration. Per due reminder, INDEPENDENTLY decides and durably
 * records an Email outcome and an SMS outcome, enqueuing eligible messages into the EXISTING
 * EmailOutbox / SmsOutbox. Never calls SendGrid or Twilio directly. Never waits for provider
 * delivery — a successful outbox enqueue is the FINAL channel decision.
 *
 * Correctness rests on: the atomic `claimNext` + per-claim ownership token fenced into every
 * write; frozen per-channel recipients (set-once) + the deterministic outbox dedupe keys, which
 * together make every retry idempotent; and the `<channel>Decision:"PENDING"` immutability
 * filter. No Mongo transaction, no lock.
 *
 * Query cost per attempt (happy path): both channels → 5 reads (booking, profile, user,
 * business, 1 between-channel booking re-read); email-only → 4; sms-only → up to 4 (the SMS body
 * needs the business name — no snapshot exists, and the email path already does this read);
 * both-off → 2 (booking, profile). No per-channel duplicate user/profile reads.
 */
export class AppointmentReminderWorker {
  public constructor(
    private readonly reminderRepository: AppointmentReminderRepository,
    private readonly bookingRepository: Pick<BookingRepository, "findByIdOnly">,
    private readonly businessRepository: Pick<BusinessRepository, "findById">,
    private readonly userRepository: Pick<UserRepository, "findById" | "findProfileByUserId">,
    private readonly notificationPolicy: CustomerNotificationPolicy,
    private readonly emailOutbox: Pick<EmailOutboxService, "enqueue">,
    private readonly smsOutbox: Pick<SmsOutboxService, "enqueue">,
    private readonly smsTransport: Pick<SmsTransport, "isConfigured">,
    private readonly options: AppointmentReminderWorkerOptions,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async runOnce(): Promise<AppointmentReminderPassCounts> {
    const c: AppointmentReminderPassCounts = {
      claimed: 0,
      recoveredStale: 0,
      completed: 0,
      retried: 0,
      failed: 0,
      skipped: 0,
      ownershipLost: 0,
      emailEnqueued: 0,
      emailSuppressed: 0,
      emailSkippedNoRecipient: 0,
      emailPendingInfraError: 0,
      smsEnqueued: 0,
      smsSuppressed: 0,
      smsSkippedNoVerifiedPhone: 0,
      smsSkippedProviderNotConfigured: 0,
      smsSkippedIneligibleBetweenChannels: 0,
      smsPendingInfraError: 0,
      failedWithPartialDispatch: 0,
      failedNoDispatch: 0,
    };

    c.recoveredStale = await this.reminderRepository.resetStaleProcessing(
      new Date(this.clock().getTime() - this.options.claimTimeoutMs),
    );

    let remaining = this.options.batchSize;
    const claimLock = { taken: 0 };

    const runner = async (): Promise<void> => {
      while (claimLock.taken < remaining) {
        claimLock.taken += 1;
        const record = await this.reminderRepository.claimNext({
          workerId: this.options.workerId,
          now: this.clock(),
          claimTimeoutMs: this.options.claimTimeoutMs,
          maxAttempts: this.options.maxAttempts,
        });
        if (!record) {
          remaining = 0;
          return;
        }
        c.claimed += 1;
        this.tally(c, await this.processOne(record));
      }
    };

    const poolSize = Math.max(1, Math.min(this.options.concurrency, this.options.batchSize));
    await Promise.all(Array.from({ length: poolSize }, () => runner()));

    return c;
  }

  private tally(c: AppointmentReminderPassCounts, r: ReminderProcessResult): void {
    if (r.status === "completed") c.completed += 1;
    else if (r.status === "skipped") c.skipped += 1;
    else if (r.status === "retried") c.retried += 1;
    else if (r.status === "ownership_lost") c.ownershipLost += 1;
    else if (r.status === "failed") {
      c.failed += 1;
      const dispatched = r.email === "enqueued" || r.sms === "enqueued";
      if (dispatched) c.failedWithPartialDispatch += 1;
      else c.failedNoDispatch += 1;
    }

    if (r.email === "enqueued") c.emailEnqueued += 1;
    else if (r.email === "suppressed_by_preference") c.emailSuppressed += 1;
    else if (r.email === "skipped_no_recipient") c.emailSkippedNoRecipient += 1;
    else if (r.email === "pending_infra_error") c.emailPendingInfraError += 1;

    if (r.sms === "enqueued") c.smsEnqueued += 1;
    else if (r.sms === "suppressed_by_preference") c.smsSuppressed += 1;
    else if (r.sms === "skipped_no_verified_phone") c.smsSkippedNoVerifiedPhone += 1;
    else if (r.sms === "skipped_provider_not_configured") c.smsSkippedProviderNotConfigured += 1;
    else if (r.sms === "skipped_ineligible") c.smsSkippedIneligibleBetweenChannels += 1;
    else if (r.sms === "pending_infra_error") c.smsPendingInfraError += 1;
  }

  public async processOne(reminder: AppointmentReminderDocument): Promise<ReminderProcessResult> {
    const token = reminder.claimedBy ?? "";
    const now = this.clock();
    const log = {
      reminderId: String(reminder._id),
      bookingId: String(reminder.bookingId),
      dedupeKey: reminder.dedupeKey,
    };

    const emailFinal = isFinalChannelDecision(reminder.emailDecision);
    const smsFinal = isFinalChannelDecision(reminder.smsDecision);
    let emailOutcome: ChannelOutcome = emailFinal ? "already_final" : "pending_infra_error";
    let smsOutcome: ChannelOutcome = smsFinal ? "already_final" : "pending_infra_error";
    let lastInfraError: unknown;

    // ---- 0. eligibility -------------------------------------------------------------------
    const booking = await this.bookingRepository.findByIdOnly(reminder.bookingId);
    const eligFail = this.eligibilityFailure(booking, reminder, now);

    if (eligFail && !emailFinal && !smsFinal) {
      const skipped = await this.reminderRepository.markSkipped(reminder._id, token, {
        reasonCategory: eligFail,
        now,
      });
      if (!skipped) return this.ownershipLost(log);
      logger.info({ ...log, reason: eligFail }, "Appointment reminder skipped (whole reminder)");
      return { status: "skipped", email: "skipped_ineligible", sms: "skipped_ineligible" };
    }

    if (eligFail) {
      // Retry with partial progress + the booking is now ineligible: resolve every still-PENDING
      // channel as SKIPPED_INELIGIBLE (a per-channel skip — the other channel already fired).
      if (!emailFinal) {
        const r = await this.reminderRepository.recordChannelDecision(reminder._id, token, {
          channel: "email",
          decision: "SKIPPED_INELIGIBLE",
          now,
        });
        if (!r) return this.ownershipLost(log);
        emailOutcome = "skipped_ineligible";
      }
      if (!smsFinal) {
        const r = await this.reminderRepository.recordChannelDecision(reminder._id, token, {
          channel: "sms",
          decision: "SKIPPED_INELIGIBLE",
          now,
        });
        if (!r) return this.ownershipLost(log);
        smsOutcome = "skipped_ineligible";
      }
      logger.info(
        { ...log, reason: eligFail },
        "Appointment reminder channels skipped — booking now ineligible",
      );
      return { status: "completed", email: emailOutcome, sms: smsOutcome };
    }

    const confirmedBooking = booking as BookingDocument;

    // ---- 1. one preference snapshot + shared reads --------------------------------------
    const profile = await this.userRepository.findProfileByUserId(reminder.customerUserId);
    const prefs = profile?.notifications;
    const smsPrefOn = resolveNotificationPreferences(prefs).appointmentReminderSms;

    const needEmail = !emailFinal;
    const needSms = !smsFinal;
    const wantEmail =
      needEmail && this.notificationPolicy.mayReceiveAppointmentReminderEmail(prefs);

    const needUserForEmail = wantEmail && !reminder.emailRecipient;
    const needUserForSms = needSms && smsPrefOn && !reminder.smsRecipientE164;
    const user =
      needUserForEmail || needUserForSms
        ? await this.userRepository.findById(reminder.customerUserId)
        : null;

    const needBusiness = wantEmail || (needSms && smsPrefOn);
    const business = needBusiness
      ? await this.businessRepository.findById(confirmedBooking.businessId)
      : null;

    if (needBusiness && !business) {
      // Rare (booking references a missing business). Skip the whole reminder if nothing has
      // been dispatched, else skip the still-PENDING channels.
      if (!emailFinal && !smsFinal) {
        const skipped = await this.reminderRepository.markSkipped(reminder._id, token, {
          reasonCategory: "BUSINESS_NOT_FOUND",
          now,
        });
        if (!skipped) return this.ownershipLost(log);
        return { status: "skipped", email: "skipped_ineligible", sms: "skipped_ineligible" };
      }
      for (const channel of ["email", "sms"] as const) {
        if (
          isFinalChannelDecision(
            channel === "email" ? reminder.emailDecision : reminder.smsDecision,
          )
        ) {
          continue;
        }
        const r = await this.reminderRepository.recordChannelDecision(reminder._id, token, {
          channel,
          decision: "SKIPPED_INELIGIBLE",
          now,
        });
        if (!r) return this.ownershipLost(log);
      }
      return { status: "completed", email: "skipped_ineligible", sms: "skipped_ineligible" };
    }

    // ---- 2. EMAIL channel (first; own try/catch) --------------------------------------
    if (needEmail) {
      try {
        const outcome = await this.processEmail(reminder, token, {
          booking: confirmedBooking,
          business,
          user,
          allowed: wantEmail,
          now,
          log,
        });
        if (outcome === OWNERSHIP_LOST) return this.ownershipLost(log);
        emailOutcome = outcome;
      } catch (error) {
        lastInfraError = error;
        emailOutcome = "pending_infra_error";
        logger.error(
          { ...log, err: error },
          "Appointment reminder email channel failed (will retry)",
        );
      }
    }

    // ---- 3. SMS channel (second; own try/catch) -------------------------------------
    if (needSms) {
      try {
        const outcome = await this.processSms(reminder, token, {
          booking: confirmedBooking,
          business,
          user,
          profile,
          prefs,
          smsPrefOn,
          emailEnqueuedThisAttempt: emailOutcome === "enqueued",
          now,
          log,
        });
        if (outcome === OWNERSHIP_LOST) return this.ownershipLost(log);
        smsOutcome = outcome;
      } catch (error) {
        lastInfraError = error;
        smsOutcome = "pending_infra_error";
        logger.error(
          { ...log, err: error },
          "Appointment reminder SMS channel failed (will retry)",
        );
      }
    }

    // ---- 4. finalize ------------------------------------------------------------------
    const emailStillPending = needEmail && emailOutcome === "pending_infra_error";
    const smsStillPending = needSms && smsOutcome === "pending_infra_error";

    if (emailStillPending || smsStillPending) {
      const exhausted = reminder.attemptCount >= this.options.maxAttempts;
      const category = emailStillPending
        ? smsStillPending
          ? "EMAIL_AND_SMS_INFRA_ERROR"
          : "EMAIL_INFRA_ERROR"
        : "SMS_INFRA_ERROR";
      const r = await this.reminderRepository.releaseForRetryOrFail(reminder._id, token, {
        category,
        message: safeMessage(lastInfraError),
        attemptsExhausted: exhausted,
        now,
      });
      if (!r) return this.ownershipLost(log);
      logger.warn(
        {
          ...log,
          emailOutcome,
          smsOutcome,
          attemptCount: reminder.attemptCount,
          willRetry: !exhausted,
        },
        exhausted
          ? "Appointment reminder FAILED — orchestration incomplete (an enqueued channel still delivers)"
          : "Appointment reminder released for retry with partial progress",
      );
      return { status: exhausted ? "failed" : "retried", email: emailOutcome, sms: smsOutcome };
    }

    // Both channels are resolved — `recordChannelDecision` auto-completed on the second one.
    logger.info(
      { ...log, emailOutcome, smsOutcome },
      "Appointment reminder completed (both channels resolved)",
    );
    return { status: "completed", email: emailOutcome, sms: smsOutcome };
  }

  // --- Email channel ---------------------------------------------------------------------

  private async processEmail(
    reminder: AppointmentReminderDocument,
    token: string,
    ctx: {
      booking: BookingDocument;
      business: Awaited<ReturnType<BusinessRepository["findById"]>> | null;
      user: Awaited<ReturnType<UserRepository["findById"]>> | null;
      allowed: boolean;
      now: Date;
      log: Record<string, string>;
    },
  ): Promise<ChannelOutcome | typeof OWNERSHIP_LOST> {
    if (!ctx.allowed) {
      const r = await this.reminderRepository.recordChannelDecision(reminder._id, token, {
        channel: "email",
        decision: "SUPPRESSED_BY_PREFERENCE",
        now: ctx.now,
      });
      if (!r) return OWNERSHIP_LOST;
      logger.info(ctx.log, "Appointment reminder email suppressed by preference");
      return "suppressed_by_preference";
    }

    let recipient = reminder.emailRecipient;
    if (!recipient) {
      const resolved =
        ctx.user?.normalizedEmail ?? ctx.booking.customer.contact.normalizedEmail ?? "";
      if (!resolved) {
        const r = await this.reminderRepository.recordChannelDecision(reminder._id, token, {
          channel: "email",
          decision: "SKIPPED_NO_RECIPIENT",
          now: ctx.now,
        });
        if (!r) return OWNERSHIP_LOST;
        logger.info(ctx.log, "Appointment reminder email skipped — no recipient");
        return "skipped_no_recipient";
      }
      const frozen = await this.reminderRepository.freezeChannelRecipient(reminder._id, token, {
        channel: "email",
        recipient: resolved,
      });
      if (!frozen) return OWNERSHIP_LOST;
      recipient = frozen.emailRecipient;
    }

    // `business` is guaranteed non-null here (needBusiness was true → checked above).
    const businessName = (ctx.business as { name: string }).name;
    const enqueueResult = await this.emailOutbox.enqueue({
      eventKey: reminder.dedupeKey,
      templateKey: "APPOINTMENT_REMINDER_24H",
      recipient: recipient as string,
      payload: buildAppointmentReminderEmailData(ctx.booking, {
        businessName,
      }) as unknown as Record<string, unknown>,
    });

    const r = await this.reminderRepository.recordChannelDecision(reminder._id, token, {
      channel: "email",
      decision: "ENQUEUED",
      outboxDedupeKey: enqueueResult.record.dedupeKey,
      now: ctx.now,
    });
    if (!r) return OWNERSHIP_LOST;
    logger.info(
      { ...ctx.log, outboxCreated: enqueueResult.created },
      "Appointment reminder email enqueued",
    );
    return "enqueued";
  }

  // --- SMS channel ----------------------------------------------------------------------

  private async processSms(
    reminder: AppointmentReminderDocument,
    token: string,
    ctx: {
      booking: BookingDocument;
      business: Awaited<ReturnType<BusinessRepository["findById"]>> | null;
      user: Awaited<ReturnType<UserRepository["findById"]>> | null;
      profile: Awaited<ReturnType<UserRepository["findProfileByUserId"]>> | null;
      prefs: Parameters<CustomerNotificationPolicy["mayReceiveAppointmentReminderSms"]>[0];
      smsPrefOn: boolean;
      emailEnqueuedThisAttempt: boolean;
      now: Date;
      log: Record<string, string>;
    },
  ): Promise<ChannelOutcome | typeof OWNERSHIP_LOST> {
    // A frozen recipient means a prior attempt already committed to a verified number; do not
    // re-resolve it (that is what makes retry idempotent across a phone change).
    const verifiedPhone = reminder.smsRecipientE164
      ? { e164: reminder.smsRecipientE164 }
      : ctx.user?.phoneVerifiedAt && ctx.profile?.phone?.e164
        ? { e164: ctx.profile.phone.e164 }
        : undefined;

    if (!ctx.smsPrefOn) {
      return this.recordSms(
        reminder,
        token,
        "SUPPRESSED_BY_PREFERENCE",
        ctx.now,
        ctx.log,
        "SMS suppressed by preference",
        "suppressed_by_preference",
      );
    }
    if (!verifiedPhone) {
      return this.recordSms(
        reminder,
        token,
        "SKIPPED_NO_VERIFIED_PHONE",
        ctx.now,
        ctx.log,
        "SMS skipped — no verified phone",
        "skipped_no_verified_phone",
      );
    }
    if (!this.smsTransport.isConfigured()) {
      return this.recordSms(
        reminder,
        token,
        "SKIPPED_PROVIDER_NOT_CONFIGURED",
        ctx.now,
        ctx.log,
        "SMS skipped — Twilio Messaging not configured",
        "skipped_provider_not_configured",
      );
    }

    // Between-channel eligibility re-check: only when the email channel actually enqueued this
    // attempt (so the email→SMS gap is real) and SMS is about to enqueue.
    let bookingForSms = ctx.booking;
    if (ctx.emailEnqueuedThisAttempt) {
      const fresh = await this.bookingRepository.findByIdOnly(reminder.bookingId);
      if (this.eligibilityFailure(fresh, reminder, ctx.now)) {
        const r = await this.reminderRepository.recordChannelDecision(reminder._id, token, {
          channel: "sms",
          decision: "SKIPPED_INELIGIBLE",
          now: ctx.now,
        });
        if (!r) return OWNERSHIP_LOST;
        logger.info(
          ctx.log,
          "Appointment reminder SMS skipped — booking became ineligible between channels",
        );
        return "skipped_ineligible";
      }
      bookingForSms = fresh as BookingDocument;
    }

    let e164 = reminder.smsRecipientE164;
    if (!e164) {
      const frozen = await this.reminderRepository.freezeChannelRecipient(reminder._id, token, {
        channel: "sms",
        recipient: verifiedPhone.e164,
      });
      if (!frozen) return OWNERSHIP_LOST;
      e164 = frozen.smsRecipientE164;
    }

    const tz = bookingForSms.schedule.timezone;
    const businessName = (ctx.business as { name: string }).name;
    const body = buildAppointmentReminderSmsMessage({
      businessName,
      appointmentDate: formatDateInTimezone(bookingForSms.schedule.startAt, tz),
      appointmentTime: formatTimeInTimezone(bookingForSms.schedule.startAt, tz),
      venueTimezone: tz,
    });

    const enqueueResult = await this.smsOutbox.enqueue({
      eventKey: `${reminder.dedupeKey}:sms`,
      recipientE164: e164 as string,
      body,
    });

    const r = await this.reminderRepository.recordChannelDecision(reminder._id, token, {
      channel: "sms",
      decision: "ENQUEUED",
      outboxDedupeKey: enqueueResult.record.dedupeKey,
      now: ctx.now,
    });
    if (!r) return OWNERSHIP_LOST;
    logger.info(
      { ...ctx.log, outboxCreated: enqueueResult.created, recipient: maskPhone(e164 as string) },
      "Appointment reminder SMS enqueued",
    );
    return "enqueued";
  }

  private async recordSms(
    reminder: AppointmentReminderDocument,
    token: string,
    decision:
      | "SUPPRESSED_BY_PREFERENCE"
      | "SKIPPED_NO_VERIFIED_PHONE"
      | "SKIPPED_PROVIDER_NOT_CONFIGURED",
    now: Date,
    log: Record<string, string>,
    message: string,
    outcome: ChannelOutcome,
  ): Promise<ChannelOutcome | typeof OWNERSHIP_LOST> {
    const r = await this.reminderRepository.recordChannelDecision(reminder._id, token, {
      channel: "sms",
      decision,
      now,
    });
    if (!r) return OWNERSHIP_LOST;
    logger.info(log, `Appointment reminder ${message}`);
    return outcome;
  }

  private ownershipLost(log: Record<string, string>): ReminderProcessResult {
    logger.info(log, "Appointment reminder ownership lost — reclaimed or retired by another actor");
    return { status: "ownership_lost", email: "pending_infra_error", sms: "pending_infra_error" };
  }

  /** Booking is no longer a valid target for this reminder → returns a category string; else
   * `undefined`. Unchanged from Stage 2: must exist, be UPCOMING, match the reminder's schedule
   * version, and not have started. */
  private eligibilityFailure(
    booking: BookingDocument | null,
    reminder: AppointmentReminderDocument,
    now: Date,
  ): string | undefined {
    if (!booking) {
      return "BOOKING_NOT_FOUND";
    }
    if (booking.status !== "UPCOMING" || TERMINAL_BOOKING_STATUSES.has(booking.status)) {
      return `BOOKING_${booking.status}`;
    }
    if (booking.schedule.startAt.getTime() !== reminder.scheduleStartAt.getTime()) {
      return "SCHEDULE_CHANGED";
    }
    if (booking.schedule.startAt.getTime() <= now.getTime()) {
      return "APPOINTMENT_ALREADY_STARTED";
    }
    return undefined;
  }
}
