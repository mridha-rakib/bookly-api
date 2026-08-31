import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "./email-layout.js";
import { emailParagraph, emailTitle } from "./email-primitives.js";

/**
 * Compatibility wrapper: gives the branded header/footer + an HTML body to the transactional
 * emails that already existed as plain subject/text pairs (the non-registration OTP purposes —
 * BUSINESS_LINK / STAFF_TEMP_PASSWORD / EMAIL_CHANGE — and `sendNotice`). Their `text` is passed
 * through verbatim so existing callers and tests keep their exact plain-text body; only an HTML
 * alternative is added. Full purpose-specific bodies for other events are Stage B/C/D work.
 */
export const renderPlainBrandedEmail = (input: {
  subject: string;
  heading: string;
  /** Verbatim plain-text body. Also drives the HTML paragraphs (split on blank lines). */
  bodyText: string;
}): RenderedEmail => {
  const paragraphs = input.bodyText
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => emailParagraph(block.replace(/\n/g, " ")))
    .join("");

  const layout = renderEmailLayout({
    preheader: input.heading,
    contentHtml: emailTitle(input.heading) + paragraphs,
    contentText: input.bodyText,
    appendFooterToText: false,
  });

  return {
    subject: input.subject,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
