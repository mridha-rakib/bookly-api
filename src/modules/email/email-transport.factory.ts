import { env } from "../../config/env.js";
import type { EmailTransport } from "./email-transport.js";
import { ResendEmailTransport } from "./resend-email-transport.js";
import { SendGridEmailTransport } from "./sendgrid-email-transport.js";
import { SmtpEmailTransport } from "./smtp-email-transport.js";

/**
 * Selects the one active transport from `EMAIL_PROVIDER`. Mirrors the existing
 * `createEmailOtpProvider` / `createSupportEmailProvider` switch — same three values, but now
 * there is a single implementation behind each instead of one per calling module.
 */
export const createEmailTransport = (): EmailTransport => {
  if (env.EMAIL_PROVIDER === "sendgrid") {
    return new SendGridEmailTransport();
  }
  if (env.EMAIL_PROVIDER === "resend") {
    return new ResendEmailTransport();
  }
  return new SmtpEmailTransport();
};
