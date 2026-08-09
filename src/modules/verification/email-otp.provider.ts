import nodemailer from "nodemailer";
import { Resend } from "resend";

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AuthError } from "../auth/auth.errors.js";

export interface EmailOtpProvider {
  sendOtp(input: { to: string; code: string }): Promise<void>;
}

type ResendClient = {
  emails: {
    send(input: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
  };
};

type SmtpTransporter = {
  sendMail(input: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
};

export class ResendEmailOtpProvider implements EmailOtpProvider {
  public constructor(
    private readonly clientFactory = (apiKey: string): ResendClient => new Resend(apiKey),
  ) {}

  public async sendOtp(input: { to: string; code: string }): Promise<void> {
    if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL || !env.RESEND_FROM_NAME) {
      throw new AuthError("PROVIDER_NOT_CONFIGURED", 503);
    }

    try {
      const resend = this.clientFactory(env.RESEND_API_KEY);
      await resend.emails.send({
        from: `${env.RESEND_FROM_NAME} <${env.RESEND_FROM_EMAIL}>`,
        to: input.to,
        subject: "Your Bookly verification code",
        text: `Your Bookly verification code is ${input.code}. It expires in ${env.OTP_EXPIRY_MINUTES} minutes.`,
      });
    } catch (error) {
      const category = classifyProviderError(error);
      logger.warn({ provider: "resend", category }, "Email OTP delivery failed");
      throw new AuthError(
        category === "rate_limited" ? "PROVIDER_RATE_LIMITED" : "OTP_DELIVERY_FAILED",
        category === "rate_limited" ? 429 : 502,
      );
    }
  }
}

export class SmtpEmailOtpProvider implements EmailOtpProvider {
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

  public async sendOtp(input: { to: string; code: string }): Promise<void> {
    if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS || !env.EMAIL_FROM) {
      throw new AuthError("PROVIDER_NOT_CONFIGURED", 503);
    }

    try {
      await this.transportFactory().sendMail({
        from: `${env.EMAIL_FROM_NAME} <${env.EMAIL_FROM}>`,
        to: input.to,
        subject: "Your Bookly verification code",
        text: `Your Bookly verification code is ${input.code}. It expires in ${env.OTP_EXPIRY_MINUTES} minutes.`,
      });
    } catch (error) {
      const category = classifyProviderError(error);
      logger.warn({ provider: "smtp", category }, "Email OTP delivery failed");
      throw new AuthError(
        category === "rate_limited" ? "PROVIDER_RATE_LIMITED" : "OTP_DELIVERY_FAILED",
        category === "rate_limited" ? 429 : 502,
      );
    }
  }
}

export const createEmailOtpProvider = (): EmailOtpProvider =>
  env.EMAIL_PROVIDER === "resend" ? new ResendEmailOtpProvider() : new SmtpEmailOtpProvider();

const classifyProviderError = (error: unknown): "rate_limited" | "delivery_failed" => {
  if (typeof error === "object" && error !== null) {
    const statusCode = "statusCode" in error ? error.statusCode : undefined;
    const status = "status" in error ? error.status : undefined;
    const responseCode = "responseCode" in error ? error.responseCode : undefined;

    if (statusCode === 429 || status === 429 || responseCode === 429) {
      return "rate_limited";
    }
  }

  return "delivery_failed";
};
