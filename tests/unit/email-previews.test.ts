import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Types } from "mongoose";
import { afterAll, describe, expect, it } from "vitest";
import type { BookingDocument } from "../../src/modules/booking/booking.model.js";
import { renderEmailTemplate } from "../../src/modules/email/template-registry.js";
import { buildBookingEmailData } from "../../src/modules/email/templates/booking/booking-email-data.js";
import { buildCancellationEmailData } from "../../src/modules/email/templates/booking/cancellation-email-data.js";
import { buildNoShowEmailData } from "../../src/modules/email/templates/booking/no-show-email-data.js";
import {
  buildInvoiceData,
  type InvoiceData,
} from "../../src/modules/email/templates/invoice/invoice-data.js";
import { InvoicePdfService } from "../../src/modules/invoice/invoice-pdf.service.js";
import { buildBooking, buildBusiness } from "./stage-b-fixtures.js";
import { NO_SHOW_CHARGED_AMOUNTS } from "./stage-d-fixtures.js";

/**
 * FINAL QA — Phase AB (local HTML preview artifacts) + Phase T (PDF file QA). Uses the ACTUAL
 * production renderers; writes to tmp/ (gitignored); no production preview endpoint or document
 * store is created.
 */
const OUT_HTML = "tmp/email-previews";
const OUT_PDF = "tmp/email-pdfs";
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const business = buildBusiness();

const bookingData = (over: Partial<BookingDocument> = {}) =>
  buildBookingEmailData(buildBooking(over), {
    businessName: business.name,
    includeCustomerBookingLink: true,
  });

const completedBooking = (over: Partial<BookingDocument> = {}): BookingDocument =>
  buildBooking({
    status: "COMPLETED" as never,
    completionPayment: {
      paid: true,
      amountCents: 2800,
      recordedAt: new Date("2026-09-05T10:30:00Z"),
      recordedBy: new Types.ObjectId(),
    } as never,
    ...over,
  });

const cancellationData = (cancelledBy: "CUSTOMER" | "BUSINESS") =>
  buildCancellationEmailData(
    buildBooking({
      status: (cancelledBy === "CUSTOMER" ? "LATE_CANCELLATION" : "CANCELLED_BY_BUSINESS") as never,
      cancellationOutcome: {
        classifiedAt: new Date(),
        tier: "UNDER_2_HOURS",
        feeMode: cancelledBy === "CUSTOMER" ? "PERCENTAGE" : "FREE",
        feePercentage: cancelledBy === "CUSTOMER" ? 50 : undefined,
        cancellationFeeCents: cancelledBy === "CUSTOMER" ? 1200 : 0,
        depositAppliedCents: cancelledBy === "CUSTOMER" ? 800 : 0,
        additionalChargeCents: cancelledBy === "CUSTOMER" ? 400 : 0,
        refundOwedCents: cancelledBy === "BUSINESS" ? 700 : 0,
        settlementStatus: "SUCCEEDED",
      } as never,
    }),
    { businessName: business.name, cancelledBy },
  );

const noShowData = (outcome: "CHARGED" | "WAIVED" | "CANCELLED") =>
  buildNoShowEmailData(buildBooking(), {
    businessName: business.name,
    outcome,
    ...(outcome === "CHARGED" ? { amounts: NO_SHOW_CHARGED_AMOUNTS } : {}),
  });

const previews: Record<string, { subject: string; html: string; text: string }> = {
  "otp-verification": renderEmailTemplate("OTP_VERIFICATION", { code: "4821", expiryMinutes: 10 }),
  "client-created": renderEmailTemplate("CLIENT_CREATED", {
    clientFirstName: "Dana",
    businessName: business.name,
  }),
  "booking-customer-confirmed": renderEmailTemplate("BOOKING_CUSTOMER_CONFIRMED", bookingData()),
  "booking-owner-new-booking": renderEmailTemplate("BOOKING_OWNER_NEW_BOOKING", bookingData()),
  "booking-for-client-confirmed": renderEmailTemplate(
    "BOOKING_FOR_CLIENT_CONFIRMED",
    bookingData(),
  ),
  "booking-staff-created": renderEmailTemplate("BOOKING_STAFF_CREATED_NOTIFICATION", {
    ...bookingData(),
    createdByLabel: "Val Sup created a booking",
  }),
  "booking-completed": renderEmailTemplate("BOOKING_COMPLETED", {
    invoice: buildInvoiceData(completedBooking(), {
      businessName: business.name,
      businessPhone: "+35799112233",
    }),
  }),
  "booking-cancelled-customer": renderEmailTemplate(
    "BOOKING_CANCELLED_CUSTOMER",
    cancellationData("CUSTOMER"),
  ),
  "booking-cancelled-owner": renderEmailTemplate(
    "BOOKING_CANCELLED_OWNER",
    cancellationData("BUSINESS"),
  ),
  "no-show-charged": renderEmailTemplate("NO_SHOW_CHARGED", noShowData("CHARGED")),
  "no-show-waived": renderEmailTemplate("NO_SHOW_WAIVED", noShowData("WAIVED")),
  "no-show-cancelled": renderEmailTemplate("NO_SHOW_CANCELLED", noShowData("CANCELLED")),
  "business-registered": renderEmailTemplate("BUSINESS_REGISTERED", {
    businessId: "6512aa000000000000000009",
    businessName: business.name,
    ownerName: "Blake Owner",
    ownerEmail: "blake@example.com",
    phone: "+35799112233",
    category: "Wellness",
    city: "Larnaca",
    status: "PENDING",
    registeredAtFormatted: "Saturday, 5 September 2026",
  }),
};

describe("FINAL QA — email preview artifacts (Phase AB)", () => {
  afterAll(() => {
    if (existsSync(OUT_HTML)) {
      // leave artifacts for manual inspection; only prune on re-run
    }
  });

  it("writes an HTML preview + a .txt for every unique template", () => {
    rmSync(OUT_HTML, { recursive: true, force: true });
    mkdirSync(OUT_HTML, { recursive: true });

    for (const [name, email] of Object.entries(previews)) {
      expect(email.html).toContain("cid:bookly-wordmark");
      expect(email.html).toContain("support@bookly.cy");
      expect(email.html).toContain("/privacy");
      expect(email.html).toContain("/terms-of-use");
      expect(email.html).not.toContain("admin@bookly.cy");
      expect(email.text.trim().length).toBeGreaterThan(60);
      expect(email.text).not.toMatch(/undefined|NaN|\[object Object\]|<[a-z]+>/i);

      writeFileSync(join(OUT_HTML, `${name}.html`), email.html, "utf8");
      writeFileSync(
        join(OUT_HTML, `${name}.txt`),
        `Subject: ${email.subject}\n\n${email.text}`,
        "utf8",
      );
    }

    const files = readdirSync(OUT_HTML);
    expect(files.filter((f) => f.endsWith(".html"))).toHaveLength(13);
  });
});

// --- Phase T: PDF file QA -----------------------------------------------------------------

const invoiceVariants: Record<string, InvoiceData> = {
  full: buildInvoiceData(completedBooking(), { businessName: business.name }),
  partial: buildInvoiceData(
    completedBooking({
      completionPayment: {
        paid: true,
        amountCents: 1000,
        recordedAt: new Date(),
        recordedBy: new Types.ObjectId(),
      } as never,
    }),
    { businessName: business.name },
  ),
  "not-paid": buildInvoiceData(
    completedBooking({
      completionPayment: {
        paid: false,
        recordedAt: new Date(),
        recordedBy: new Types.ObjectId(),
      } as never,
    }),
    { businessName: business.name },
  ),
  "not-recorded": buildInvoiceData(completedBooking({ completionPayment: undefined }), {
    businessName: business.name,
  }),
  promo: buildInvoiceData(
    completedBooking({
      promo: {
        promoId: new Types.ObjectId(),
        code: "WELCOME",
        type: "FIXED",
        value: 300,
        discountCents: 300,
        chargeCents: 400,
        fundingOwner: "BOOKLY",
        appliedAt: new Date(),
      } as never,
    }),
    { businessName: business.name },
  ),
  "travel-and-discount": buildInvoiceData(
    completedBooking({
      financials: {
        currency: "EUR",
        servicesSubtotalCents: 5000,
        addonsSubtotalCents: 800,
        serviceDiscountCents: 500,
        travelFeeCents: 1200,
        eligiblePlatformFeeBasisCents: 5300,
        platformFeeCents: 700,
        depositCents: 700,
        balanceDueCents: 6500,
        totalCents: 7200,
      } as never,
      completionPayment: {
        paid: true,
        amountCents: 6500,
        recordedAt: new Date(),
        recordedBy: new Types.ObjectId(),
      } as never,
    }),
    {
      businessName: business.name,
      businessPhone: "+35799112233",
      businessAddress: "1 Main St, Larnaca",
    },
  ),
};

describe("FINAL QA — invoice PDF variants (Phase T)", () => {
  it("every variant produces a valid, greppable PDF with the expected content", async () => {
    rmSync(OUT_PDF, { recursive: true, force: true });
    mkdirSync(OUT_PDF, { recursive: true });
    const service = new InvoicePdfService({ compress: false });

    for (const [name, invoice] of Object.entries(invoiceVariants)) {
      const pdf = await service.renderInvoice(invoice);
      writeFileSync(join(OUT_PDF, `Bookly-Invoice-${name}.pdf`), pdf);

      expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      expect(pdf.subarray(-1024).toString("latin1")).toContain("%%EOF");
      expect(pdf.length).toBeGreaterThan(800);
      expect(pdf.length).toBeLessThan(200_000);

      const hex = [...pdf.toString("latin1").matchAll(/<([0-9a-fA-F]{2,})>/g)]
        .map((m) =>
          m[1] && m[1].length % 2 === 0 ? Buffer.from(m[1], "hex").toString("latin1") : "",
        )
        .join("")
        .replace(/\s+/g, "");
      expect(hex).toContain(invoice.bookingReference);
      expect(hex).toContain("SohoVintageBarbers");
      expect(hex).toContain("Paymentstatus:");
      expect(hex).toContain("support@bookly.cy".replace(/\s/g, ""));
    }
  });

  it("PDF embeds the Bookly wordmark as a real image XObject (not the text fallback)", async () => {
    const invoice = invoiceVariants["full"] as InvoiceData;
    const pdf = await new InvoicePdfService({ compress: false }).renderInvoice(invoice);
    const raw = pdf.toString("latin1");
    // pdfkit re-encodes the PNG into a FlateDecode image XObject sized to the source PNG.
    expect(raw).toMatch(/\/Subtype\s*\/Image/);
    expect(raw).toMatch(/\/Width\s*520/); // the official Bookly wordmark's pixel width
    expect(PNG_SIG.length).toBe(4); // keep the import referenced
  });
});
