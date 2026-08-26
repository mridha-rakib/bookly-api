import sgMail from "@sendgrid/mail";
import nodemailer from "nodemailer";
import { Resend } from "resend";

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

/**
 * Batch 15B — minimal generic transactional email sender for Support/Contact. The codebase's
 * existing `EmailOtpProvider` (verification/email-otp.provider.ts) cannot be reused directly: its
 * own interface is deliberately hardcoded to a `{code, purpose}` shape with a fixed template per
 * purpose (confirmed by investigation — it is NOT a generic "send arbitrary email" facility).
 * Support genuinely needs a free subject/text (a ticket reference + acknowledgement, or an admin
 * reply notice) that doesn't fit that contract.
 *
 * Rather than widen the OTP provider's contract (risking behavior changes to unrelated
 * registration/staff-password flows) or build a new notification platform (explicitly out of
 * scope), this mirrors the EXACT SAME Resend/SMTP construction, env-var config, and error
 * classification as `EmailOtpProvider` — same transport, same failure handling, just a narrower
 * "arbitrary subject/text" method instead of a purpose-templated one. This is "reuse the existing
 * email infrastructure" at the transport/config level, since the interface itself is genuinely
 * incompatible.
 */
export interface SupportEmailProvider {
  send(input: { to: string; subject: string; text: string }): Promise<void>;
}

type ResendClient = {
  emails: {
    send(input: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
  };
};

type SmtpTransporter = {
  sendMail(input: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
};

type SendGridClient = {
  send(input: { to: string; from: string; subject: string; text: string }): Promise<unknown>;
};

/** Thrown only for a genuine send failure; callers in this module always catch this and log
 * rather than let it fail the surrounding request (confirmed rule: "An email-provider failure
 * must NOT cause an already-created valid SupportTicket to disappear"). */
export class SupportEmailDeliveryError extends Error {
  public constructor(
    public readonly category: "not_configured" | "rate_limited" | "delivery_failed",
    cause?: unknown,
  ) {
    super(`Support email delivery failed: ${category}`, { cause });
    this.name = "SupportEmailDeliveryError";
  }
}

export class ResendSupportEmailProvider implements SupportEmailProvider {
  public constructor(
    private readonly clientFactory = (apiKey: string): ResendClient => new Resend(apiKey),
  ) {}

  public async send(input: { to: string; subject: string; text: string }): Promise<void> {
    if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL || !env.RESEND_FROM_NAME) {
      throw new SupportEmailDeliveryError("not_configured");
    }

    try {
      const resend = this.clientFactory(env.RESEND_API_KEY);
      await resend.emails.send({
        from: `${env.RESEND_FROM_NAME} <${env.RESEND_FROM_EMAIL}>`,
        to: input.to,
        subject: input.subject,
        text: input.text,
      });
    } catch (error) {
      const category = classifyProviderError(error);
      logger.warn({ provider: "resend", category }, "Support email delivery failed");
      throw new SupportEmailDeliveryError(category, error);
    }
  }
}

/** Batch 19.1 — mirrors ResendSupportEmailProvider exactly, same rationale as
 * SendGridEmailOtpProvider in verification/email-otp.provider.ts (kept as a parallel hierarchy
 * rather than merged, per this file's own top-of-file comment on why Support can't reuse the OTP
 * provider's purpose-templated interface). */
export class SendGridSupportEmailProvider implements SupportEmailProvider {
  public constructor(
    private readonly clientFactory = (apiKey: string): SendGridClient => {
      sgMail.setApiKey(apiKey);
      return sgMail;
    },
  ) {}

  public async send(input: { to: string; subject: string; text: string }): Promise<void> {
    if (!env.SENDGRID_API_KEY || !env.EMAIL_FROM) {
      throw new SupportEmailDeliveryError("not_configured");
    }

    try {
      const client = this.clientFactory(env.SENDGRID_API_KEY);
      await client.send({
        to: input.to,
        from: `${env.EMAIL_FROM_NAME} <${env.EMAIL_FROM}>`,
        subject: input.subject,
        text: input.text,
      });
    } catch (error) {
      const category = classifyProviderError(error);
      logger.warn({ provider: "sendgrid", category }, "Support email delivery failed");
      throw new SupportEmailDeliveryError(category, error);
    }
  }
}

export class SmtpSupportEmailProvider implements SupportEmailProvider {
  public constructor(
    private readonly transportFactory = (): SmtpTransporter =>
      nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: {
          user: env.SMTP_USER,
          pass: env.SMTP_PASS,
        },
      }),
  ) {}

  public async send(input: { to: string; subject: string; text: string }): Promise<void> {
    if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS || !env.EMAIL_FROM) {
      throw new SupportEmailDeliveryError("not_configured");
    }

    try {
      await this.transportFactory().sendMail({
        from: `${env.EMAIL_FROM_NAME} <${env.EMAIL_FROM}>`,
        to: input.to,
        subject: input.subject,
        text: input.text,
      });
    } catch (error) {
      const category = classifyProviderError(error);
      logger.warn({ provider: "smtp", category }, "Support email delivery failed");
      throw new SupportEmailDeliveryError(category, error);
    }
  }
}

export const createSupportEmailProvider = (): SupportEmailProvider => {
  if (env.EMAIL_PROVIDER === "sendgrid") {
    return new SendGridSupportEmailProvider();
  }
  if (env.EMAIL_PROVIDER === "resend") {
    return new ResendSupportEmailProvider();
  }
  return new SmtpSupportEmailProvider();
};

/** The address the public Contact form's message is sent TO — falls back to whichever address
 * the configured provider already sends FROM, so no brand-new mandatory env var is required just
 * to stand this up (see env.ts's own comment on SUPPORT_CONTACT_INBOX_EMAIL). Returns `undefined`
 * only if genuinely nothing is configured (e.g. local dev with no email env vars at all) — the
 * caller treats that the same as any other delivery failure. */
export const resolveContactInboxEmail = (): string | undefined =>
  env.SUPPORT_CONTACT_INBOX_EMAIL ??
  (env.EMAIL_PROVIDER === "resend" ? env.RESEND_FROM_EMAIL : env.EMAIL_FROM);

const classifyProviderError = (error: unknown): "rate_limited" | "delivery_failed" => {
  if (typeof error === "object" && error !== null) {
    const statusCode = "statusCode" in error ? error.statusCode : undefined;
    const status = "status" in error ? error.status : undefined;
    const responseCode = "responseCode" in error ? error.responseCode : undefined;
    const code = "code" in error ? error.code : undefined;

    if (statusCode === 429 || status === 429 || responseCode === 429 || code === 429) {
      return "rate_limited";
    }
  }

  return "delivery_failed";
};
