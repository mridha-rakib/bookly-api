import twilio from "twilio";

import { env } from "../../config/env.js";
import { AuthError } from "../auth/auth.errors.js";

export interface PhoneOtpProvider {
  sendOtp(input: { toE164: string }): Promise<{ providerVerificationId?: string }>;
  verifyOtp(input: { toE164: string; code: string }): Promise<boolean>;
}

export class TwilioVerifyPhoneOtpProvider implements PhoneOtpProvider {
  public async sendOtp(input: { toE164: string }): Promise<{ providerVerificationId?: string }> {
    const client = this.createClient();
    const verification = await client.verify.v2
      .services(env.TWILIO_VERIFY_SERVICE_SID ?? "")
      .verifications.create({ to: input.toE164, channel: "sms" });

    return { providerVerificationId: verification.sid };
  }

  public async verifyOtp(input: { toE164: string; code: string }): Promise<boolean> {
    const client = this.createClient();
    const result = await client.verify.v2
      .services(env.TWILIO_VERIFY_SERVICE_SID ?? "")
      .verificationChecks.create({ to: input.toE164, code: input.code });

    return result.status === "approved";
  }

  private createClient() {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_VERIFY_SERVICE_SID) {
      throw new AuthError("PROVIDER_NOT_CONFIGURED", 503);
    }

    return twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }
}
