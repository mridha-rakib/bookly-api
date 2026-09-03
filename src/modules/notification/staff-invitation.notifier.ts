import { logger } from "../../config/logger.js";
import type { EmailOtpProvider } from "../verification/email-otp.provider.js";

type NoticeSender = Pick<EmailOtpProvider, "sendNotice">;

export type StaffInvitationEmailInput = {
  to: string;
  businessName: string;
  role: "SUPERVISOR" | "STAFF";
  /** Ready-to-click accept URL on the web app, already carrying the raw token. */
  acceptUrl: string;
  /** Local, human-readable expiry (e.g. "in 3 days"). */
  expiresInText: string;
};

/**
 * Sends the "you've been invited to join {business}" link email for Phase 2D. Uses the SAME
 * synchronous branded-notice transport the existing staff temp-password email used
 * (`EmailOtpProvider.sendNotice`) — no new outbox template. The invitation link is the mailbox-
 * ownership proof, so the copy never contains a password or code.
 *
 * `send` throws on delivery failure so the caller can surface a distinct
 * STAFF_INVITATION_EMAIL_FAILED (mirrors the old STAFF_TEMP_PASSWORD_EMAIL_FAILED contract).
 */
export class StaffInvitationNotifier {
  public constructor(private readonly emailProvider: NoticeSender) {}

  public async send(input: StaffInvitationEmailInput): Promise<void> {
    const roleLabel = input.role === "SUPERVISOR" ? "Supervisor" : "Staff";
    const subject = `You're invited to join ${input.businessName} on Bookly`;
    const text = [
      `${input.businessName} has invited you to join their team on Bookly as ${roleLabel}.`,
      "",
      `Accept your invitation and set up your account here:`,
      input.acceptUrl,
      "",
      `This link expires ${input.expiresInText}. If you weren't expecting this, you can ignore this email.`,
    ].join("\n");

    try {
      await this.emailProvider.sendNotice({ to: input.to, subject, text });
    } catch (error) {
      logger.warn({ err: error }, "Staff invitation email delivery failed");
      throw error;
    }
  }
}
