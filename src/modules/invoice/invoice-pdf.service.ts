import PDFDocument from "pdfkit";

import { getBooklyWordmarkBuffer } from "../email/assets/bookly-email-assets.js";
import { SUPPORT_EMAIL } from "../email/email.config.js";
import type { InvoiceData } from "../email/templates/invoice/invoice-data.js";

/**
 * All pdfkit usage in the codebase lives behind this one class (no Puppeteer, no headless
 * browser, no filesystem persistence). Stage C implements {@link renderInvoice} from the shared
 * {@link InvoiceData}; the email worker calls it once per send attempt and attaches the Buffer.
 */
const INK = "#0F172A";
const MUTED = "#8A94A6";
const CYAN = "#06B6D4";
const RULE = "#E6E9EF";

export class InvoicePdfService {
  /** `compress` defaults to true (smaller attachments in production). Tests pass `false` so the
   * text streams stay greppable for content assertions. */
  public constructor(private readonly options: { compress?: boolean } = {}) {}

  /** Stage A smoke test — kept so the pdfkit-foundation test stays valid. */
  public generateSmokeTestPdf(text = "Bookly PDF pipeline OK"): Promise<Buffer> {
    return this.toBuffer((doc) => {
      doc.fontSize(18).text(text, { align: "left" });
    });
  }

  /**
   * Renders the branded booking invoice / summary PDF from the SAME InvoiceData the email body
   * uses. Pure presentation — prints already-formatted strings, computes nothing.
   */
  public renderInvoice(data: InvoiceData): Promise<Buffer> {
    return this.toBuffer((doc) => {
      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const contentWidth = right - left;

      // --- Brand + title -------------------------------------------------------------------
      try {
        doc.image(getBooklyWordmarkBuffer(), left, doc.y, { width: 130 });
      } catch {
        doc.fontSize(18).fillColor(INK).text("Bookly.cy", left, doc.y);
      }
      doc.moveDown(2.2);
      doc.fontSize(16).fillColor(INK).text("INVOICE / BOOKING SUMMARY", left);
      doc
        .moveTo(left, doc.y + 4)
        .lineTo(right, doc.y + 4)
        .lineWidth(2)
        .strokeColor(CYAN)
        .stroke();
      doc.moveDown(1);

      // --- Reference block ---------------------------------------------------------------
      doc.fontSize(10).fillColor(MUTED);
      doc
        .text(`Invoice / Booking reference: `, { continued: true })
        .fillColor(INK)
        .text(data.invoiceReference);
      doc
        .fillColor(MUTED)
        .text("Issued: ", { continued: true })
        .fillColor(INK)
        .text(data.issuedAtFormatted);
      doc.moveDown(0.8);

      // --- Business / customer ---------------------------------------------------------------
      const colWidth = contentWidth / 2 - 10;
      const blockTop = doc.y;
      doc.fontSize(9).fillColor(MUTED).text("BUSINESS", left, blockTop);
      doc.fontSize(11).fillColor(INK).text(data.business.name, left, doc.y, { width: colWidth });
      if (data.business.phone)
        doc.fontSize(10).fillColor(INK).text(data.business.phone, { width: colWidth });
      if (data.business.address)
        doc.fontSize(10).fillColor(INK).text(data.business.address, { width: colWidth });
      const businessBottom = doc.y;

      doc
        .fontSize(9)
        .fillColor(MUTED)
        .text("CUSTOMER", left + colWidth + 20, blockTop);
      doc
        .fontSize(11)
        .fillColor(INK)
        .text(data.customer.name, left + colWidth + 20, blockTop + 12, { width: colWidth });
      if (data.customer.email)
        doc.fontSize(10).fillColor(INK).text(data.customer.email, { width: colWidth });

      doc.y = Math.max(businessBottom, doc.y) + 12;

      // --- Appointment --------------------------------------------------------------------
      doc.fontSize(9).fillColor(MUTED).text("APPOINTMENT", left);
      doc
        .fontSize(10)
        .fillColor(INK)
        .text(
          `${data.appointment.dateFormatted}, ${data.appointment.timeFormatted} (${data.appointment.durationMin} min)`,
          left,
        );
      doc.moveDown(0.8);

      this.rule(doc, left, right);

      // --- Line items -------------------------------------------------------------------
      const amountX = right - 90;
      doc.fontSize(9).fillColor(MUTED);
      doc.text("Description", left, doc.y, { continued: true });
      doc.text("Amount", amountX, doc.y, { width: 90, align: "right" });
      doc.moveDown(0.4);
      doc.fontSize(10).fillColor(INK);
      for (const item of data.lineItems) {
        const y = doc.y;
        doc.text(item.kind === "ADDON" ? `${item.label} (add-on)` : item.label, left, y, {
          width: amountX - left - 8,
        });
        doc.text(item.amountFormatted, amountX, y, { width: 90, align: "right" });
        doc.moveDown(0.3);
      }
      doc.moveDown(0.3);
      this.rule(doc, left, right);

      // --- Financial summary -----------------------------------------------------------
      const f = data.financial;
      const summaryRow = (label: string, value: string, strong = false): void => {
        const y = doc.y;
        doc
          .fontSize(strong ? 11 : 10)
          .fillColor(strong ? INK : MUTED)
          .text(label, left, y, { width: amountX - left - 8 });
        doc
          .fontSize(strong ? 11 : 10)
          .fillColor(INK)
          .text(value, amountX, y, { width: 90, align: "right" });
        doc.moveDown(0.35);
      };

      summaryRow("Services subtotal", f.servicesSubtotalFormatted);
      if (f.show.addons) summaryRow("Add-ons", f.addonsSubtotalFormatted);
      if (f.show.serviceDiscount) summaryRow("Discount", `-${f.serviceDiscountFormatted}`);
      if (f.show.promoDiscount) summaryRow("Promo discount", `-${f.promoDiscountFormatted}`);
      if (f.show.travelFee) summaryRow("Travel", f.travelFeeFormatted);
      summaryRow("Total", f.totalFormatted, true);
      summaryRow("Paid online", f.upfrontPaidFormatted);
      if (f.show.venuePayment) summaryRow("Paid at venue", f.venuePaymentFormatted);
      summaryRow("Total paid", f.totalPaidFormatted, true);
      if (f.show.outstanding) summaryRow("Outstanding", f.outstandingFormatted, true);

      doc.moveDown(0.4);
      doc.fontSize(11).fillColor(INK).text(`Payment status: ${f.settlementLabel}`, left);

      doc.moveDown(1);
      this.rule(doc, left, right);
      doc
        .fontSize(9)
        .fillColor(MUTED)
        .text(`${SUPPORT_EMAIL}`, left)
        .text("Bookly.cy — this is an automated transactional invoice.", left);
    });
  }

  private rule(doc: PDFKit.PDFDocument, left: number, right: number): void {
    doc
      .moveTo(left, doc.y + 2)
      .lineTo(right, doc.y + 2)
      .lineWidth(0.5)
      .strokeColor(RULE)
      .stroke();
    doc.moveDown(0.6);
  }

  protected toBuffer(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({
        size: "A4",
        margin: 50,
        compress: this.options.compress ?? true,
      });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      try {
        draw(doc);
        doc.end();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
