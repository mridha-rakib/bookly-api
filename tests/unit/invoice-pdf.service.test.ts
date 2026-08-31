import { describe, expect, it } from "vitest";

import { InvoiceAttachmentResolver } from "../../src/modules/invoice/invoice-attachment.resolver.js";
import { InvoicePdfService } from "../../src/modules/invoice/invoice-pdf.service.js";
import { buildInvoiceDataFixture } from "./stage-c-fixtures.js";

/** MAILING STAGE C — pdfkit invoice (Part AE items 34–45) + Stage A foundation (item 43). */

/** pdfkit (Helvetica/WinAnsi) writes visible text as `<hex>` runs in the content stream.
 * Decode every hex run and strip whitespace so kerning-split words match. */
const greppable = (pdf: Buffer): string => {
  const raw = pdf.toString("latin1");
  let out = "";
  for (const match of raw.matchAll(/<([0-9a-fA-F]{2,})>/g)) {
    const hex = match[1] ?? "";
    if (hex.length % 2 === 0) {
      out += Buffer.from(hex, "hex").toString("latin1");
    }
  }
  return out.replace(/\s+/g, "");
};

describe("InvoicePdfService", () => {
  it("43 (Stage A) generateSmokeTestPdf returns a valid non-empty PDF buffer", async () => {
    const pdf = await new InvoicePdfService().generateSmokeTestPdf("Bookly Stage A");
    expect(pdf.length).toBeGreaterThan(100);
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("34/35 renderInvoice returns a valid PDF buffer starting with %PDF", async () => {
    const pdf = await new InvoicePdfService().renderInvoice(buildInvoiceDataFixture());
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(300);
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.subarray(-1024).toString("latin1")).toContain("%%EOF");
  });

  it("38/39/40/41/42 PDF contains reference, business, customer, line items, payment summary", async () => {
    const pdf = await new InvoicePdfService({ compress: false }).renderInvoice(
      buildInvoiceDataFixture(),
    );
    const text = greppable(pdf);
    expect(text).toContain("BK-7F3K9QZC");
    expect(text).toContain("SohoVintageBarbers");
    expect(text).toContain("DanaKlein");
    expect(text).toContain("Haircut");
    expect(text).toContain("Beardtrim");
    expect(text).toContain("Totalpaid");
    expect(text).toContain("Paidinfull");
  });

  it("43 FULL/PARTIAL/NOT_PAID labels render", async () => {
    const label = async (settlementLabel: string) => {
      const data = buildInvoiceDataFixture();
      data.financial.settlementLabel = settlementLabel;
      const pdf = await new InvoicePdfService({ compress: false }).renderInvoice(data);
      return greppable(pdf);
    };
    expect(await label("Paid in full")).toContain("Paidinfull");
    expect(await label("Partially paid")).toContain("Partiallypaid");
    expect(await label("Not paid at venue")).toContain("Notpaidatvenue");
  });

  it("44/45 omits optional zero rows; shows outstanding when non-zero", async () => {
    const base = buildInvoiceDataFixture();
    const full = greppable(await new InvoicePdfService({ compress: false }).renderInvoice(base));
    expect(full).not.toContain("Outstanding");
    expect(full).not.toContain("Travel");

    const partial = buildInvoiceDataFixture();
    partial.financial.outstandingFormatted = "€18.00";
    partial.financial.show.outstanding = true;
    partial.financial.travelFeeFormatted = "€5.00";
    partial.financial.show.travelFee = true;
    const withRows = greppable(
      await new InvoicePdfService({ compress: false }).renderInvoice(partial),
    );
    expect(withRows).toContain("Outstanding");
    expect(withRows).toContain("Travel");
  });
});

describe("InvoiceAttachmentResolver", () => {
  it("36/37 returns one sanitized application/pdf attachment for BOOKING_COMPLETED", async () => {
    const out = await new InvoiceAttachmentResolver().resolve("BOOKING_COMPLETED", {
      invoice: buildInvoiceDataFixture({ bookingReference: "BK/7 F3*K9" }),
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("application/pdf");
    expect(out[0]?.disposition).toBe("attachment");
    expect(out[0]?.filename).toBe("Bookly-Invoice-BK7F3K9.pdf");
    expect(out[0]?.filename).not.toMatch(/[^A-Za-z0-9._-]/);
    expect(out[0]?.content.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("returns [] for any non-BOOKING_COMPLETED template", async () => {
    expect(await new InvoiceAttachmentResolver().resolve("OTP_VERIFICATION", {})).toEqual([]);
    expect(await new InvoiceAttachmentResolver().resolve("BOOKING_CUSTOMER_CONFIRMED", {})).toEqual(
      [],
    );
  });
});
