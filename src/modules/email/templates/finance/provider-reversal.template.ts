import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import { emailMutedNote, emailParagraph, emailTitle } from "../components/email-primitives.js";

/**
 * P6 — provider-originated reversal notifications (disputes / chargebacks and refunds made
 * outside Bookly). Pure presentation: every value is a display string the caller derived from
 * provider-confirmed data. Copy never promises a dispute outcome, never claims money moved before
 * the provider confirmed it, and never reaches a customer.
 */
export type ProviderReversalBusinessKind =
  | "DISPUTE_OPENED"
  | "DISPUTE_FUNDS_WITHDRAWN"
  | "DISPUTE_FUNDS_REINSTATED"
  | "DISPUTE_WON"
  | "DISPUTE_LOST"
  | "EXTERNAL_REFUND";

export type ProviderReversalBusinessEmailData = {
  kind: ProviderReversalBusinessKind;
  businessName: string;
  amountFormatted: string;
  bookingReference: string;
  providerReference: string;
};

export type FinanceSupportAlertKind =
  | "REFUND_RECOVERY_CONFLICT"
  | "DISPUTE_NEW"
  | "DISPUTE_INVESTIGATION"
  | "DISPUTE_RECONCILIATION_REQUIRED"
  | "EXTERNAL_REFUND"
  | "EXTERNAL_REFUND_INVESTIGATION"
  | "WEBHOOK_FAILED";

export type FinanceSupportAlertEmailData = {
  kind: FinanceSupportAlertKind;
  providerReference: string;
  amountFormatted?: string;
  businessId?: string;
  bookingId?: string;
  detail?: string;
};

const businessCopy = (
  data: ProviderReversalBusinessEmailData,
): { title: string; lines: string[] } => {
  const ref = data.bookingReference;
  switch (data.kind) {
    case "DISPUTE_OPENED":
      return {
        title: "Payment dispute opened",
        lines: [
          `A card issuer has opened a dispute on a payment of ${data.amountFormatted} for booking ${ref}. The outcome is not decided yet.`,
          "If the payment provider withdraws funds for this dispute, that amount and the provider's dispute fee are deducted from your payable balance — carried forward against future payouts if the payment was already paid out. Bookly handles the response with the payment provider.",
        ],
      };
    case "DISPUTE_FUNDS_WITHDRAWN":
      return {
        title: "Funds deducted for a payment dispute",
        lines: [
          `The payment provider has withdrawn ${data.amountFormatted} for the dispute on booking ${ref}.`,
          "This amount and the provider's dispute fee are deducted from your payable balance, or carried forward against future payouts if the payment was already paid out. A withdrawal does not by itself mean the dispute is decided.",
        ],
      };
    case "DISPUTE_FUNDS_REINSTATED":
      return {
        title: "Disputed funds reinstated",
        lines: [
          `The payment provider has returned ${data.amountFormatted} for the dispute on booking ${ref}. It has been added back to your payable balance.`,
        ],
      };
    case "DISPUTE_WON":
      return {
        title: "Payment dispute closed",
        lines: [`The dispute on booking ${ref} has been closed in favour of the payment.`],
      };
    case "DISPUTE_LOST":
      return {
        title: "Payment dispute closed",
        lines: [
          `The dispute on booking ${ref} has been closed against the payment. Any withdrawn funds remain deducted from your payable balance.`,
        ],
      };
    case "EXTERNAL_REFUND":
      return {
        title: "Refund recorded",
        lines: [
          `A refund of ${data.amountFormatted} for booking ${ref} was made directly with the payment provider. It has been deducted from your payable balance, or carried forward against future payouts if the payment was already paid out.`,
        ],
      };
  }
};

const supportCopy = (data: FinanceSupportAlertEmailData): { title: string; lines: string[] } => {
  const facts = [
    data.kind === "REFUND_RECOVERY_CONFLICT"
      ? `Internal refund operation reference: ${data.providerReference}`
      : `Provider reference: ${data.providerReference}`,
    ...(data.amountFormatted ? [`Amount: ${data.amountFormatted}`] : []),
    ...(data.businessId ? [`Business: ${data.businessId}`] : []),
    ...(data.bookingId ? [`Booking: ${data.bookingId}`] : []),
    ...(data.detail ? [`Detail: ${data.detail}`] : []),
  ];
  const titles: Record<FinanceSupportAlertKind, string> = {
    REFUND_RECOVERY_CONFLICT: "Refund recovery requires investigation",
    DISPUTE_NEW: "New payment dispute",
    DISPUTE_INVESTIGATION: "Payment dispute needs investigation",
    DISPUTE_RECONCILIATION_REQUIRED: "Payment dispute needs reconciliation",
    EXTERNAL_REFUND: "Refund made outside Bookly recorded",
    EXTERNAL_REFUND_INVESTIGATION: "Refund made outside Bookly needs investigation",
    WEBHOOK_FAILED: "Stripe webhook event permanently failed",
  };
  return { title: titles[data.kind], lines: facts };
};

const render = (copy: { title: string; lines: string[] }, subject: string, note?: string) => {
  const contentHtml =
    emailTitle(copy.title) +
    copy.lines.map((line) => emailParagraph(line)).join("") +
    (note ? emailMutedNote(note) : "");
  const contentText = [copy.title, "", ...copy.lines, ...(note ? ["", note] : [])].join("\n");
  const layout = renderEmailLayout({ preheader: copy.title, contentHtml, contentText });
  return { subject, html: layout.html, text: layout.text, attachments: layout.attachments };
};

export const renderProviderReversalBusinessEmail = (
  data: ProviderReversalBusinessEmailData,
): RenderedEmail => {
  const copy = businessCopy(data);
  return render(copy, `${copy.title} — ${data.bookingReference}`);
};

export const renderFinanceSupportAlertEmail = (
  data: FinanceSupportAlertEmailData,
): RenderedEmail => {
  const copy = supportCopy(data);
  return render(
    copy,
    `[Finance] ${copy.title} — ${data.providerReference}`,
    data.kind === "REFUND_RECOVERY_CONFLICT"
      ? "Review the current internal incident state. This alert does not authorize a refund or financial change."
      : "Evidence and responses are handled in the Stripe Dashboard.",
  );
};
