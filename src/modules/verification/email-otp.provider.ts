import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AuthError } from "../auth/auth.errors.js";
import { EmailError } from "../email/email.errors.js";
import type { RenderedEmail } from "../email/email.types.js";
import type { EmailTransport } from "../email/email-transport.js";
import { ResendEmailTransport } from "../email/resend-email-transport.js";
import { SendGridEmailTransport } from "../email/sendgrid-email-transport.js";
import { SmtpEmailTransport } from "../email/smtp-email-transport.js";
import { renderPlainBrandedEmail } from "../email/templates/components/plain-branded-email.js";
import { renderOtpVerificationEmail } from "../email/templates/otp/otp-verification.template.js";

export type EmailOtpPurpose =
  | "REGISTRATION"
  | "BUSINESS_LINK"
  | "STAFF_TEMP_PASSWORD"
  | "EMAIL_CHANGE";

export interface EmailOtpProvider {
  /**
   * Sends a short-lived-credential transactional email built from a purpose + single secret
   * string — OTP codes and staff temporary passwords both fit that shape. The `code` field
   * carries the temporary password for STAFF_TEMP_PASSWORD.
   *
   * This is a SYNCHRONOUS, awaited send (Phase D / Phase U): a delivery failure surfaces to the
   * caller as an `AuthError`, because the user cannot proceed without the code. OTP is never
   * placed in the EmailOutbox.
   */
  sendOtp(input: { to: string; code: string; purpose?: EmailOtpPurpose }): Promise<void>;

  /** Plain transactional notice with no secret/code (e.g. "your email was changed"). */
  sendNotice(input: { to: string; subject: string; text: string }): Promise<void>;
}

/**
 * Purpose-specific subject/text for the non-registration purposes. REGISTRATION now renders
 * through the branded {@link renderOtpVerificationEmail} template instead (Phase V); the copy
 * here for the other purposes is unchanged from before the central-transport refactor.
 */
const buildLegacyOtpContent = (
  code: string,
  purpose: EmailOtpPurpose,
): { subject: string; heading: string; text: string } => {
  if (purpose === "BUSINESS_LINK") {
    return {
      subject: "Verify your Bookly business connection request",
      heading: "Verify your business connection request",
      text: `Someone requested to connect their Bookly business profile with your business account. This does not transfer ownership of your business. Enter this verification code in Bookly to approve the connection: ${code}. It expires in ${env.OTP_EXPIRY_MINUTES} minutes. If you did not expect this, you can safely ignore this email.`,
    };
  }

  if (purpose === "STAFF_TEMP_PASSWORD") {
    return {
      subject: "Your Bookly staff account is ready",
      heading: "Your Bookly staff account is ready",
      text: `A Bookly staff account was created for you. Log in at the Bookly professional login using this email address and the temporary password below, then change your password once you're in:\n\nTemporary password: ${code}\n\nIf you were not expecting this, please contact the business that added you.`,
    };
  }

  if (purpose === "EMAIL_CHANGE") {
    return {
      subject: "Verify your new Bookly email address",
      heading: "Verify your new email address",
      text: `Enter this code in Bookly to confirm your new email address: ${code}. It expires in ${env.OTP_EXPIRY_MINUTES} minutes. If you didn't request this, you can safely ignore this email.`,
    };
  }

  return {
    subject: "Your Bookly verification code",
    heading: "Your Bookly verification code",
    text: `Your Bookly verification code is ${code}. It expires in ${env.OTP_EXPIRY_MINUTES} minutes.`,
  };
};

const renderOtpEmail = (code: string, purpose: EmailOtpPurpose): RenderedEmail => {
  if (purpose === "REGISTRATION") {
    return renderOtpVerificationEmail({ code, expiryMinutes: env.OTP_EXPIRY_MINUTES });
  }
  const legacy = buildLegacyOtpContent(code, purpose);
  return renderPlainBrandedEmail({
    subject: legacy.subject,
    heading: legacy.heading,
    bodyText: legacy.text,
  });
};

/** Maps a transport {@link EmailError} onto the existing OTP AuthError codes — nothing else is
 * copied across, so a provider response body/key in `cause` never reaches the HTTP surface. */
const toAuthError = (error: unknown): AuthError => {
  if (error instanceof EmailError) {
    if (error.category === "NOT_CONFIGURED") {
      return new AuthError("PROVIDER_NOT_CONFIGURED", 503);
    }
    if (error.category === "RATE_LIMITED") {
      return new AuthError("PROVIDER_RATE_LIMITED", 429);
    }
    return new AuthError("OTP_DELIVERY_FAILED", 502);
  }
  return new AuthError("OTP_DELIVERY_FAILED", 502);
};

abstract class TransportBackedEmailOtpProvider implements EmailOtpProvider {
  protected constructor(private readonly transport: EmailTransport) {}

  private async deliver(to: string, rendered: RenderedEmail, kind: string): Promise<void> {
    try {
      await this.transport.send({
        to,
        subject: rendered.subject,
        text: rendered.text,
        ...(rendered.html ? { html: rendered.html } : {}),
        ...(rendered.attachments ? { attachments: rendered.attachments } : {}),
      });
    } catch (error) {
      const category = error instanceof EmailError ? error.category : "unknown";
      // Category only — never the code, recipient, or provider body.
      logger.warn({ provider: this.transport.provider, category }, `${kind} delivery failed`);
      throw toAuthError(error);
    }
  }

  public async sendOtp(input: {
    to: string;
    code: string;
    purpose?: EmailOtpPurpose;
  }): Promise<void> {
    await this.deliver(
      input.to,
      renderOtpEmail(input.code, input.purpose ?? "REGISTRATION"),
      "Email OTP",
    );
  }

  public async sendNotice(input: { to: string; subject: string; text: string }): Promise<void> {
    await this.deliver(
      input.to,
      renderPlainBrandedEmail({
        subject: input.subject,
        heading: input.subject,
        bodyText: input.text,
      }),
      "Notice email",
    );
  }
}

type SendGridClientFactory = ConstructorParameters<typeof SendGridEmailTransport>[0];
type SmtpTransporterFactory = ConstructorParameters<typeof SmtpEmailTransport>[0];
type ResendClientFactory = ConstructorParameters<typeof ResendEmailTransport>[0];

export class SendGridEmailOtpProvider extends TransportBackedEmailOtpProvider {
  public constructor(clientFactory?: SendGridClientFactory) {
    super(clientFactory ? new SendGridEmailTransport(clientFactory) : new SendGridEmailTransport());
  }
}

export class SmtpEmailOtpProvider extends TransportBackedEmailOtpProvider {
  public constructor(transporterFactory?: SmtpTransporterFactory) {
    super(
      transporterFactory ? new SmtpEmailTransport(transporterFactory) : new SmtpEmailTransport(),
    );
  }
}

export class ResendEmailOtpProvider extends TransportBackedEmailOtpProvider {
  public constructor(clientFactory?: ResendClientFactory) {
    super(clientFactory ? new ResendEmailTransport(clientFactory) : new ResendEmailTransport());
  }
}

export const createEmailOtpProvider = (): EmailOtpProvider => {
  if (env.EMAIL_PROVIDER === "sendgrid") {
    return new SendGridEmailOtpProvider();
  }
  if (env.EMAIL_PROVIDER === "resend") {
    return new ResendEmailOtpProvider();
  }
  return new SmtpEmailOtpProvider();
};
