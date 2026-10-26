import { z } from "zod";
import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import { emailParagraph, emailTitle } from "../components/email-primitives.js";
export const packageSessionNoticeSchema = z
  .object({
    title: z.string().min(1).max(160),
    businessName: z.string().min(1),
    bookingReference: z.string().min(1),
    message: z.string().min(1).max(2000),
  })
  .strict();
export const renderPackageSessionNotice = (input: unknown): RenderedEmail => {
  const d = packageSessionNoticeSchema.parse(input);
  const facts = `Booking ${d.bookingReference} with ${d.businessName}.`;
  const layout = renderEmailLayout({
    preheader: d.title,
    contentHtml: emailTitle(d.title) + emailParagraph(facts) + emailParagraph(d.message),
    contentText: [d.title, facts, d.message].join("\n\n"),
  });
  return { subject: d.title, ...layout };
};
