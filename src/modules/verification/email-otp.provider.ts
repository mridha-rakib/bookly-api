import { Resend } from "resend";

import { env } from "../../config/env.js";
import { AuthError } from "../auth/auth.errors.js";

export interface EmailOtpProvider {
  sendOtp(input: { to: string; code: string }): Promise<void>;
}

export class ResendEmailOtpProvider implements EmailOtpProvider {
  public async sendOtp(input: { to: string; code: string }): Promise<void> {
    if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL || !env.RESEND_FROM_NAME) {
      throw new AuthError("PROVIDER_NOT_CONFIGURED", 503);
    }

    const resend = new Resend(env.RESEND_API_KEY);
    await resend.emails.send({
      from: `${env.RESEND_FROM_NAME} <${env.RESEND_FROM_EMAIL}>`,
      to: input.to,
      subject: "Your Bookly verification code",
      text: `Your Bookly verification code is ${input.code}. It expires in 10 minutes.`,
    });
  }
}
