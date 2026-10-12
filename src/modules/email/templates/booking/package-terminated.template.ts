import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import { emailParagraph, emailTitle } from "../components/email-primitives.js";
export type PackageTerminatedPayload = {
  packageName: string;
  businessName: string;
  refundStatus: string;
};
export function renderPackageTerminatedEmail(data: PackageTerminatedPayload): RenderedEmail {
  const refund =
    data.refundStatus === "SUCCEEDED"
      ? "The recorded upfront refund has been processed."
      : data.refundStatus === "FAILED"
        ? "The upfront refund could not be completed. Please contact the business."
        : data.refundStatus === "PENDING"
          ? "The upfront refund is pending."
          : "No provider refund was required for this package cancellation.";
  const text = `${data.packageName} with ${data.businessName} has been cancelled. Remaining entitlement cannot be scheduled. ${refund}`;
  return {
    subject: "Your package has been cancelled",
    ...renderEmailLayout({
      preheader: "Package cancelled",
      contentHtml: emailTitle("Package cancelled") + emailParagraph(text),
      contentText: text,
    }),
  };
}
