import type {
  EmailProviderName,
  EmailTransportSendInput,
  EmailTransportSendResult,
} from "./email.types.js";

/**
 * The single transport contract every provider adapter implements (Phase B). Templates and
 * domain services depend on this, never on a concrete provider.
 */
export interface EmailTransport {
  readonly provider: EmailProviderName;
  /** True when the environment holds everything this provider needs to actually send. */
  isConfigured(): boolean;
  /** Resolves on provider acceptance; throws {@link import("./email.errors.js").EmailError}. */
  send(input: EmailTransportSendInput): Promise<EmailTransportSendResult>;
}

/** `jane.doe@example.com` -> `j***e@example.com`. Used everywhere a recipient is logged. */
export const maskEmail = (value: string): string => {
  const trimmed = value.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) {
    return "***";
  }
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const maskedLocal =
    local.length <= 2 ? `${local[0] ?? "*"}***` : `${local[0]}***${local[local.length - 1]}`;
  return `${maskedLocal}@${domain}`;
};
