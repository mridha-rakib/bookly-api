import { SUPPORT_EMAIL } from "../../email.config.js";
import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import { emailMutedNote, emailParagraph, emailTitle } from "../components/email-primitives.js";
import type { PenaltySettlementEmailData } from "./penalty-settlement-email-data.js";

/**
 * P5 — the truthful penalty settlement follow-up. Rendered only for a DURABLE outcome
 * (SUCCEEDED / FAILED / WAIVED); a pending or unknown provider outcome is never emailed as
 * either success or failure. A failed collection never claims a charge, a waiver or a resolved
 * no-show, and nothing here promises a refund.
 */
const feeName = (data: PenaltySettlementEmailData): string =>
  data.kind === "CANCELLATION_FEE" ? "additional cancellation fee" : "no-show fee";

const customerCopy = (data: PenaltySettlementEmailData): { title: string; lines: string[] } => {
  const fee = feeName(data);
  const subjectOf = `your booking ${data.bookingReference} with ${data.businessName}`;
  if (data.outcome === "SUCCEEDED") {
    return {
      title: data.kind === "CANCELLATION_FEE" ? "Cancellation fee charged" : "No-show fee charged",
      lines: [
        `Hi ${data.customerFirstName}, the ${fee} of ${data.amountFormatted} for ${subjectOf} has been charged to your saved card.`,
      ],
    };
  }
  if (data.outcome === "WAIVED") {
    return {
      title: data.kind === "CANCELLATION_FEE" ? "Cancellation fee waived" : "No-show fee waived",
      lines: [
        `Hi ${data.customerFirstName}, ${data.businessName} has waived the ${fee} of ${data.amountFormatted} for ${subjectOf}. You will not be charged for it.`,
      ],
    };
  }
  return {
    title:
      data.kind === "CANCELLATION_FEE"
        ? "Cancellation fee not collected"
        : "No-show fee not collected",
    lines: [
      `Hi ${data.customerFirstName}, we could not collect the ${fee} of ${data.amountFormatted} for ${subjectOf}. No successful charge has been confirmed.`,
      data.kind === "CANCELLATION_FEE"
        ? "Your booking remains cancelled."
        : `The no-show is awaiting review by ${data.businessName}, who may waive the fee or contact you about it.`,
    ],
  };
};

const ownerCopy = (data: PenaltySettlementEmailData): { title: string; lines: string[] } => {
  const fee = feeName(data);
  const subjectOf = `${data.customerName}'s booking ${data.bookingReference}`;
  if (data.outcome === "SUCCEEDED") {
    return {
      title: data.kind === "CANCELLATION_FEE" ? "Cancellation fee charged" : "No-show fee charged",
      lines: [`The ${fee} of ${data.amountFormatted} for ${subjectOf} was charged successfully.`],
    };
  }
  if (data.outcome === "WAIVED") {
    return {
      title: data.kind === "CANCELLATION_FEE" ? "Cancellation fee waived" : "No-show fee waived",
      lines: [`The ${fee} of ${data.amountFormatted} for ${subjectOf} was waived.`],
    };
  }
  return {
    title:
      data.kind === "CANCELLATION_FEE"
        ? "Cancellation fee not collected"
        : "No-show fee not collected",
    lines: [
      `The ${fee} of ${data.amountFormatted} for ${subjectOf} could not be collected. No successful charge has been confirmed, and it will not be retried automatically.`,
      data.kind === "CANCELLATION_FEE"
        ? "The booking remains cancelled. You can waive the fee from the booking."
        : "The no-show remains pending until you resolve it: you can waive the fee or cancel the no-show from the booking.",
    ],
  };
};

export const penaltySettlementCustomerSubject = (data: PenaltySettlementEmailData): string =>
  customerCopy(data).title;

export const penaltySettlementOwnerSubject = (data: PenaltySettlementEmailData): string =>
  `${ownerCopy(data).title} — ${data.bookingReference}`;

const render = (
  copy: { title: string; lines: string[] },
  subject: string,
  preheader: string,
  includeSupport: boolean,
): RenderedEmail => {
  const supportLine = `If you have questions, contact us at ${SUPPORT_EMAIL}.`;
  const contentHtml =
    emailTitle(copy.title) +
    copy.lines.map((line) => emailParagraph(line)).join("") +
    (includeSupport ? emailMutedNote(supportLine) : "");
  const contentText = [
    copy.title,
    "",
    ...copy.lines.flatMap((line) => [line, ""]),
    ...(includeSupport ? [supportLine] : []),
  ].join("\n");
  const layout = renderEmailLayout({ preheader, contentHtml, contentText });
  return { subject, html: layout.html, text: layout.text, attachments: layout.attachments };
};

export const renderPenaltySettlementCustomerEmail = (
  data: PenaltySettlementEmailData,
): RenderedEmail =>
  render(
    customerCopy(data),
    penaltySettlementCustomerSubject(data),
    `Update on booking ${data.bookingReference}`,
    true,
  );

export const renderPenaltySettlementOwnerEmail = (
  data: PenaltySettlementEmailData,
): RenderedEmail =>
  render(
    ownerCopy(data),
    penaltySettlementOwnerSubject(data),
    `${data.customerName} — booking ${data.bookingReference}`,
    false,
  );
