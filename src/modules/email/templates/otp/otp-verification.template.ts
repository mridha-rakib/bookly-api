import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import {
  emailCodeCard,
  emailMutedNote,
  emailParagraph,
  emailTitle,
} from "../components/email-primitives.js";

/**
 * TRIGGER 1 — customer email verification OTP (Phase V). Purpose-specific, security-focused
 * copy: this must never read like a booking confirmation. The expiry is passed in from the real
 * OTP config (`env.OTP_EXPIRY_MINUTES`) by the caller — this template never hardcodes it.
 */
export type OtpVerificationPayload = {
  /** The verification code. Rendered in the email body only — never logged by the caller. */
  code: string;
  /** From `env.OTP_EXPIRY_MINUTES`. */
  expiryMinutes: number;
};

export const OTP_VERIFICATION_SUBJECT = "Verify your Bookly email" as const;

export const renderOtpVerificationEmail = (payload: OtpVerificationPayload): RenderedEmail => {
  const minutesLabel = `${payload.expiryMinutes} minute${payload.expiryMinutes === 1 ? "" : "s"}`;

  const contentHtml =
    emailTitle("Verify your email") +
    emailParagraph(
      "Thanks for signing up with Bookly.cy. Use the verification code below to confirm your email address and finish setting up your account.",
    ) +
    emailCodeCard(payload.code) +
    emailParagraph(`This code will expire in ${minutesLabel}.`) +
    emailMutedNote(
      "If you didn't request this code, you can safely ignore this email — no changes will be made to your account.",
    );

  const contentText = [
    "Verify your email",
    "",
    "Thanks for signing up with Bookly.cy. Use the verification code below to confirm your email address and finish setting up your account.",
    "",
    `Your verification code: ${payload.code}`,
    "",
    `This code will expire in ${minutesLabel}.`,
    "",
    "If you didn't request this code, you can safely ignore this email — no changes will be made to your account.",
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `Your Bookly verification code expires in ${minutesLabel}.`,
    contentHtml,
    contentText,
  });

  return {
    subject: OTP_VERIFICATION_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
