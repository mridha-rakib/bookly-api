import type {
  SmsProviderName,
  SmsTransportSendInput,
  SmsTransportSendResult,
} from "./sms.types.js";

/**
 * The single transport contract every SMS provider adapter implements. Callers (Stage 3B's
 * SmsOutboxWorker) depend on this, never on a concrete provider. No reminder logic, no
 * preference logic, no DB access, no retry logic lives behind this interface — only "hand this
 * body to the provider for this number".
 */
export interface SmsTransport {
  readonly provider: SmsProviderName;
  /** True when the environment holds everything this provider needs to actually send. */
  isConfigured(): boolean;
  /** Resolves on provider acceptance; throws {@link import("./sms.errors.js").SmsError}. */
  send(input: SmsTransportSendInput): Promise<SmsTransportSendResult>;
}

/** `+35799123456` -> `+3579****3456`. Used everywhere a recipient number is logged. */
export const maskPhone = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length <= 6) {
    return "***";
  }
  return `${trimmed.slice(0, 5)}****${trimmed.slice(-4)}`;
};
