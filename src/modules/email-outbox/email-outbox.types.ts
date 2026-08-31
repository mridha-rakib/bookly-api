import type { EmailProviderName } from "../email/email.types.js";
import type { EmailTemplateKey } from "../email/template-registry.js";

export const emailOutboxStatuses = ["PENDING", "PROCESSING", "SENT", "FAILED"] as const;
export type EmailOutboxStatus = (typeof emailOutboxStatuses)[number];

/**
 * Deterministic idempotency key (Phase O). A retried API request or a worker restart re-derives
 * the exact same string, and the unique index on it makes a duplicate enqueue a no-op.
 */
export const buildEmailDedupeKey = (
  eventKey: string,
  templateKey: EmailTemplateKey,
  normalizedRecipient: string,
): string => `${eventKey}::${templateKey}::${normalizedRecipient}`;

export const normalizeEmailRecipient = (recipient: string): string =>
  recipient.trim().toLowerCase();

export type EnqueueEmailInput = {
  eventKey: string;
  templateKey: EmailTemplateKey;
  recipient: string;
  payload: Record<string, unknown>;
};

export type { EmailProviderName, EmailTemplateKey };
