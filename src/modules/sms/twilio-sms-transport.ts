import twilio from "twilio";

import { env } from "../../config/env.js";
import { classifySmsProviderError, SmsError } from "./sms.errors.js";
import type { SmsTransportSendInput, SmsTransportSendResult } from "./sms.types.js";
import type { SmsTransport } from "./sms-transport.js";

/**
 * THE canonical Twilio **Messaging** transport — the only place `client.messages.create` is
 * called. Completely separate from {@link import("../verification/phone-otp.provider.js").TwilioVerifyPhoneOtpProvider},
 * which owns `client.verify.v2.services(...)` for OTP: different API, different Service SID,
 * different concern. This transport is never used for OTP and never calls Verify.
 *
 * Sender strategy: a Twilio **Messaging Service SID** (`TWILIO_MESSAGING_SERVICE_SID`, starts
 * `MG...`) — it owns the sender pool, per-country routing and STOP/HELP compliance on Twilio's
 * side. There is deliberately NO hard-coded `from` number fallback.
 */
type TwilioMessageResult = {
  sid?: string | null;
  status?: string | null;
  errorCode?: number | null;
  errorMessage?: string | null;
};

type TwilioMessagesClient = {
  messages: {
    create(input: {
      messagingServiceSid: string;
      to: string;
      body: string;
    }): Promise<TwilioMessageResult>;
  };
};

export class TwilioSmsTransport implements SmsTransport {
  public readonly provider = "twilio" as const;

  public constructor(
    private readonly clientFactory = (
      accountSid: string,
      authToken: string,
    ): TwilioMessagesClient => twilio(accountSid, authToken) as unknown as TwilioMessagesClient,
  ) {}

  public isConfigured(): boolean {
    return Boolean(
      env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_MESSAGING_SERVICE_SID,
    );
  }

  public async send(input: SmsTransportSendInput): Promise<SmsTransportSendResult> {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_MESSAGING_SERVICE_SID) {
      throw new SmsError("NOT_CONFIGURED", {
        safeProviderMessage: "TWILIO_MESSAGING_SERVICE_SID (and account SID / auth token) unset",
      });
    }

    let result: TwilioMessageResult;
    try {
      result = await this.clientFactory(
        env.TWILIO_ACCOUNT_SID,
        env.TWILIO_AUTH_TOKEN,
      ).messages.create({
        messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
        to: input.to,
        body: input.body,
      });
    } catch (error) {
      const { category, providerStatus, safeProviderMessage } = classifySmsProviderError(error);
      throw new SmsError(category, {
        ...(providerStatus === undefined ? {} : { providerStatus }),
        ...(safeProviderMessage === undefined ? {} : { safeProviderMessage }),
        cause: error,
      });
    }

    // A synchronous `failed` / `undelivered` status, or a per-message `errorCode`, is a
    // rejection even though the HTTP call itself succeeded — classify it the same way.
    if (result.errorCode != null || result.status === "failed" || result.status === "undelivered") {
      const { category, safeProviderMessage } = classifySmsProviderError({
        code: result.errorCode ?? undefined,
        message: result.errorMessage ?? undefined,
      });
      throw new SmsError(category, {
        ...(safeProviderMessage === undefined ? {} : { safeProviderMessage }),
      });
    }

    return {
      provider: "twilio",
      status: "PROVIDER_ACCEPTED",
      ...(result.sid ? { providerMessageId: result.sid } : {}),
    };
  }
}
