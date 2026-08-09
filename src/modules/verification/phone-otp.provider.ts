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
      logger.warn(
        { provider: "twilio", category: classifyProviderError(error) },
        "Phone OTP delivery failed",
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
