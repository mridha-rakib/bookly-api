import type { BookingCompletedEmailPayload } from "../email/templates/booking/booking-completed.template.js";
import { sanitizeInvoiceReference } from "../email/templates/invoice/invoice-data.js";
import type { EmailAttachmentResolver } from "../email-outbox/email-outbox-worker.js";
import { InvoicePdfService } from "./invoice-pdf.service.js";

/**
 * Stage C worker plug-in: for a `BOOKING_COMPLETED` outbox row, render the invoice PDF once
 * (from the same `InvoiceData` on the payload) and hand it back as a normal `application/pdf`
 * attachment. Every other template gets `[]`.
 */
export class InvoiceAttachmentResolver implements EmailAttachmentResolver {
  public constructor(private readonly pdfService: InvoicePdfService = new InvoicePdfService()) {}

  public async resolve(
    templateKey: string,
    payload: unknown,
  ): Promise<
    Array<{ filename: string; content: Buffer; type: string; disposition: "attachment" }>
  > {
    if (templateKey !== "BOOKING_COMPLETED") {
      return [];
    }
    const { invoice } = payload as BookingCompletedEmailPayload;
    const buffer = await this.pdfService.renderInvoice(invoice);
    const safeReference = sanitizeInvoiceReference(invoice.bookingReference);
    return [
      {
        filename: `Bookly-Invoice-${safeReference}.pdf`,
        content: buffer,
        type: "application/pdf",
        disposition: "attachment",
      },
    ];
  }
}
