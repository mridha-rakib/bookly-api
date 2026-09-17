import twilio from "twilio";

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AuthError } from "../auth/auth.errors.js";

export interface PhoneOtpProvider {
  sendOtp(input: { toE164: string }): Promise<{ providerVerificationId?: string }>;
  verifyOtp(input: { toE164: string; code: string }): Promise<boolean>;
}

type TwilioVerifyClient = {
  verify: {
    v2: {
      services(serviceSid: string): {
        verifications: {
          create(input: { to: string; channel: "sms" }): Promise<{ sid?: string }>;
        };
        verificationChecks: {
          create(input: { to: string; code: string }): Promise<{ status?: string }>;
        };
      };
    };
  };
};

export class TwilioVerifyPhoneOtpProvider implements PhoneOtpProvider {
  public constructor(
    private readonly clientFactory = (accountSid: string, authToken: string): TwilioVerifyClient =>
      twilio(accountSid, authToken) as TwilioVerifyClient,
  ) {}

  public async sendOtp(input: { toE164: string }): Promise<{ providerVerificationId?: string }> {
    const client = this.createClient();
    try {
      const verification = await client.verify.v2
        .services(env.TWILIO_VERIFY_SERVICE_SID ?? "")
        .verifications.create({ to: input.toE164, channel: "sms" });

      return verification.sid ? { providerVerificationId: verification.sid } : {};
    } catch (error) {
      // TEMPORARY diagnostic logging — narrows why Twilio Verify rejected the request.
      // Deliberately excludes credentials/SIDs/headers/full phone; safe to leave enabled briefly
      // but should be removed (or the destination field dropped) once the root cause is captured.
      logger.warn(
        {
          provider: "twilio",
          category: classifyProviderError(error),
          ...extractSafeProviderErrorDetails(error),
          destination: maskE164ForLog(input.toE164),
        },
        "Twilio Verify OTP send failed",
      );
      throw new AuthError(
        classifyProviderError(error) === "rate_limited"
          ? "PROVIDER_RATE_LIMITED"
          : "OTP_DELIVERY_FAILED",
        classifyProviderError(error) === "rate_limited" ? 429 : 502,
      );
    }
  }

  public async verifyOtp(input: { toE164: string; code: string }): Promise<boolean> {
    const client = this.createClient();
    try {
      const result = await client.verify.v2
        .services(env.TWILIO_VERIFY_SERVICE_SID ?? "")
        .verificationChecks.create({ to: input.toE164, code: input.code });

      return result.status === "approved";
    } catch (error) {
      logger.warn(
        { provider: "twilio", category: classifyProviderError(error) },
        "Phone OTP verification failed",
      );
      throw new AuthError(
        classifyProviderError(error) === "rate_limited"
          ? "PROVIDER_RATE_LIMITED"
          : "OTP_VERIFICATION_FAILED",
        classifyProviderError(error) === "rate_limited" ? 429 : 502,
      );
    }
  }

  private createClient() {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_VERIFY_SERVICE_SID) {
      throw new AuthError("PROVIDER_NOT_CONFIGURED", 503);
    }

    return this.clientFactory(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }
}

export class DummyPhoneOtpProvider implements PhoneOtpProvider {
  public async sendOtp(_input: { toE164: string }): Promise<{ providerVerificationId?: string }> {
    this.assertConfigured();
    return { providerVerificationId: "dummy-phone-otp" };
  }

  public async verifyOtp(input: { toE164: string; code: string }): Promise<boolean> {
    this.assertConfigured();
    return input.code === env.DUMMY_PHONE_OTP_CODE;
  }

  private assertConfigured(): void {
    if (env.NODE_ENV === "production" || env.OTP_PROVIDER !== "dummy") {
      throw new AuthError("PROVIDER_NOT_CONFIGURED", 503);
    }

    if (!env.DUMMY_PHONE_OTP_CODE) {
      throw new AuthError("PROVIDER_NOT_CONFIGURED", 503);
    }
  }
}

export const createPhoneOtpProvider = (): PhoneOtpProvider =>
  env.OTP_PROVIDER === "dummy" ? new DummyPhoneOtpProvider() : new TwilioVerifyPhoneOtpProvider();

const classifyProviderError = (error: unknown): "rate_limited" | "provider_failed" => {
  if (typeof error === "object" && error !== null) {
    const status = "status" in error ? error.status : undefined;
    const statusCode = "statusCode" in error ? error.statusCode : undefined;
    const code = "code" in error ? error.code : undefined;

    if (status === 429 || statusCode === 429 || code === 20429) {
      return "rate_limited";
    }
  }

  return "provider_failed";
};

/**
 * TEMPORARY diagnostic helper — narrows an unknown thrown value down to the handful of fields
 * Twilio's REST error shape (`RestException`) carries, without assuming that shape. Only ever
 * reads primitive `status`/`code`/`message`/`moreInfo` — never logs the error object itself
 * (which could carry request/response metadata), never touches credentials, SIDs, or headers.
 */
const extractSafeProviderErrorDetails = (
  error: unknown,
): { status?: number | string; code?: number | string; message?: string; moreInfo?: string } => {
  if (typeof error !== "object" || error === null) {
    return {};
  }

  const record = error as Record<string, unknown>;
  const status = record["status"];
  const code = record["code"];
  const message = record["message"];
  const moreInfo = record["moreInfo"];

  return {
    ...(typeof status === "number" || typeof status === "string" ? { status } : {}),
    ...(typeof code === "number" || typeof code === "string" ? { code } : {}),
    ...(typeof message === "string" ? { message } : {}),
    ...(typeof moreInfo === "string" ? { moreInfo } : {}),
  };
};

/**
 * TEMPORARY diagnostic helper — logs enough of the destination to correlate a log line with a
 * specific country/report ("which market is failing"), never the full E.164 number. Keeps a
 * leading `+` + up to 3 country-code digits and the trailing 4 digits; everything in between
 * (the actual subscriber number) is replaced with `*`.
 */
const maskE164ForLog = (e164: string): string => {
  const leading = e164.slice(0, 4); // "+" + up to 3 country-code digits
  const trailing = e164.slice(-4);
  const maskedLength = Math.max(e164.length - leading.length - trailing.length, 0);
  return `${leading}${"*".repeat(maskedLength)}${trailing}`;
};
