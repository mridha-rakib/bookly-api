import type { SmsProviderName } from "../sms/sms.types.js";

export const smsOutboxStatuses = ["PENDING", "PROCESSING", "SENT", "FAILED"] as const;
export type SmsOutboxStatus = (typeof smsOutboxStatuses)[number];

/**
 * Deterministic idempotency key — a retried enqueue (or a worker restart) re-derives the exact
 * same string, and the unique index on it makes a duplicate enqueue a no-op. Mirrors
 * {@link import("../email-outbox/email-outbox.types.js").buildEmailDedupeKey} but without a
 * template key: an SmsOutbox row already carries the final `body`, so `(eventKey, recipient)`
 * fully identifies one logical SMS.
 */
export const buildSmsDedupeKey = (eventKey: string, normalizedRecipientE164: string): string =>
  `${eventKey}::${normalizedRecipientE164}`;

/** Basic E.164 shape: `+` then 8–15 digits, first digit non-zero. SmsOutbox expects an
 * already-normalized, already-verified number from its caller (Stage 3B); this only rejects
 * obviously malformed / empty values at the infrastructure boundary. */
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

export const isValidE164 = (value: string): boolean => E164_PATTERN.test(value.trim());

export const normalizeSmsRecipient = (recipient: string): string => recipient.trim();

export type EnqueueSmsInput = {
  eventKey: string;
  /** E.164, already normalized + verified by the caller. */
  recipientE164: string;
  /** The FINAL message text — frozen on the row, sent verbatim on every retry. */
  body: string;
  /** Non-secret provider-side tags (eventKey, kind, …). */
  metadata?: Record<string, string> | undefined;
};

export type { SmsProviderName };
