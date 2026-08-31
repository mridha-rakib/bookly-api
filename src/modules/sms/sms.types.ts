/**
 * Transport-neutral SMS types. Nothing here (or anywhere a caller can see) references Twilio —
 * provider-specific mapping lives only in `twilio-sms-transport.ts`, mirroring the email
 * module's transport/adapter split.
 */

export type SmsProviderName = "twilio";

/** The transport-level send contract. `body` is the FINAL text — the transport does not render
 * anything. `metadata` is non-secret key/value tags for provider-side searchability. */
export type SmsTransportSendInput = {
  /** E.164, e.g. `+35799123456`. Callers pass an already-normalized, verified number. */
  to: string;
  body: string;
  metadata?: Record<string, string>;
};

export type SmsTransportSendResult = {
  provider: SmsProviderName;
  /**
   * A 2xx / queued from the provider means "accepted for delivery", never "delivered to the
   * handset" — without a delivery webhook this is the strongest claim we can make.
   */
  status: "PROVIDER_ACCEPTED";
  providerMessageId?: string;
};
