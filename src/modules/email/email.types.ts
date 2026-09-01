/**
 * MAILING STAGE A — transport-neutral email types.
 *
 * Nothing in this file (or anywhere a template/domain service can see) references SendGrid,
 * nodemailer, or Resend. Provider-specific mapping lives only in the `*-email-transport.ts`
 * infrastructure adapters.
 */

export type EmailProviderName = "sendgrid" | "smtp" | "resend";

/**
 * One attachment on an outgoing email. `content` is always a decoded Buffer here — provider
 * adapters do the base64/stream conversion each provider actually wants. `disposition: "inline"`
 * + `contentId` turns it into a `cid:` referenceable image (see the branded header/footer).
 */
export type EmailAttachment = {
  filename: string;
  content: Buffer;
  /** MIME type, e.g. "image/png", "application/pdf". */
  type: string;
  disposition?: "attachment" | "inline";
  /** Bare id (no angle brackets), referenced from HTML as `src="cid:<contentId>"`. */
  contentId?: string;
};

/**
 * What every branded email template returns. `html` is mandatory for templates (Phase J/K:
 * no HTML-only *and* no text-only branded email). The raw Support/Contact notification path is
 * deliberately NOT a template and may send text-only through the transport directly.
 */
export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
};

/** The transport-level send contract. `html` is optional here so the plain Support path can
 * pass text only; templates always provide it. */
export type EmailTransportSendInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailAttachment[];
  /** Safe, non-secret key/value tags for provider-side searchability (templateKey, eventKey). */
  metadata?: Record<string, string>;
  /**
   * Provider-neutral extra MIME headers. Only populated by callers that genuinely need them —
   * today that is the marketing-email path adding `List-Unsubscribe` / `List-Unsubscribe-Post`
   * (Stage M2). Transactional/OTP sends never set this, so their on-the-wire headers are
   * unchanged. Never put secrets here — every adapter forwards the map verbatim.
   */
  headers?: Record<string, string>;
};

export type EmailTransportSendResult = {
  provider: EmailProviderName;
  /**
   * A 2xx from the provider means "accepted for delivery", never "delivered to the inbox"
   * (Phase M / Phase S). Without a delivery webhook this is the strongest claim we can make.
   */
  status: "PROVIDER_ACCEPTED";
  providerMessageId?: string;
};
