import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderEmailTemplate } from "../../src/modules/email/template-registry.js";
import { renderBookingCustomerConfirmedEmail } from "../../src/modules/email/templates/booking/booking-customer-confirmed.template.js";
import { buildBookingEmailData } from "../../src/modules/email/templates/booking/booking-email-data.js";
import { renderBookingForClientConfirmedEmail } from "../../src/modules/email/templates/booking/booking-for-client-confirmed.template.js";
import { renderBookingOwnerNewBookingEmail } from "../../src/modules/email/templates/booking/booking-owner-new-booking.template.js";
import { renderBookingStaffCreatedEmail } from "../../src/modules/email/templates/booking/booking-staff-created.template.js";
import { renderClientCreatedEmail } from "../../src/modules/email/templates/client/client-created.template.js";
import { buildBooking } from "./stage-b-fixtures.js";

/** MAILING STAGE B — templates (Part T items 26–32, 12, 34). */

const bookingData = () =>
  buildBookingEmailData(buildBooking(), {
    businessName: "Soho Vintage Barbers",
    includeCustomerBookingLink: true,
  });

const allRendered = () => [
  renderClientCreatedEmail({ clientFirstName: "Dana", businessName: "Soho Vintage Barbers" }),
  renderBookingCustomerConfirmedEmail(bookingData()),
  renderBookingOwnerNewBookingEmail(bookingData()),
  renderBookingForClientConfirmedEmail(bookingData()),
  renderBookingStaffCreatedEmail({ ...bookingData(), createdByLabel: "You created a booking" }),
];

describe("Stage B email templates", () => {
  it("26 every Stage-B template produces non-empty HTML and text", () => {
    for (const email of allRendered()) {
      expect(email.subject.length).toBeGreaterThan(0);
      expect(email.html).toContain("<");
      expect(email.text.length).toBeGreaterThan(40);
      expect(email.attachments?.length).toBeGreaterThan(0);
    }
  });

  it("27/28/29/30/31/32 every template uses the shared branded header/footer", () => {
    for (const email of allRendered()) {
      expect(email.html).toContain("cid:bookly-wordmark");
      expect(email.html).toContain("support@bookly.cy");
      expect(email.html).toContain("/privacy");
      expect(email.html).toContain("/terms-of-use");
      expect(email.html).not.toContain("admin@bookly.cy");
      const lower = `${email.html}\n${email.text}`.toLowerCase();
      expect(lower).not.toContain("beforelisted");
      expect(lower).not.toContain("pennymore");
      expect(lower).not.toContain("vercel.app");
    }
  });

  it("15 customer-created wording differs from business-created wording", () => {
    const selfBooked = renderBookingCustomerConfirmedEmail(bookingData());
    const bookedForClient = renderBookingForClientConfirmedEmail(bookingData());

    expect(selfBooked.text).toContain("your booking with Soho Vintage Barbers is confirmed");
    expect(bookedForClient.text).toContain(
      "Soho Vintage Barbers has booked an appointment for you",
    );
    expect(bookedForClient.text).not.toContain("Thanks for");
    expect(selfBooked.text).not.toEqual(bookedForClient.text);
  });

  it("11 financial figures are the persisted booking values, not recomputed", () => {
    const email = renderBookingCustomerConfirmedEmail(bookingData());
    // financials: total 3500, deposit 700 (== promo-less paid-now), balance 2800
    expect(email.text).toContain("Total: €35.00");
    expect(email.text).toContain("Paid online now: €7.00");
    expect(email.text).toContain("Balance due at the venue: €28.00");
  });

  it("promo charge is used verbatim as 'paid online now' when present", () => {
    const promoBooking = buildBooking({
      promo: {
        promoId: bookingData().reference as never,
        code: "WELCOME",
        type: "FIXED",
        value: 300,
        discountCents: 300,
        chargeCents: 400,
        fundingOwner: "BOOKLY",
        appliedAt: new Date(),
      } as never,
    });
    const data = buildBookingEmailData(promoBooking, {
      businessName: "Soho Vintage Barbers",
      includeCustomerBookingLink: false,
    });
    expect(renderBookingCustomerConfirmedEmail(data).text).toContain("Paid online now: €4.00");
  });

  it("12 template + section source files contain no money arithmetic", () => {
    const dir = "src/modules/email/templates";
    const offenders: string[] = [];
    const walk = (path: string): void => {
      for (const entry of readdirSync(path)) {
        const full = join(path, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.template\.ts$|details-section\.ts$/.test(entry)) {
          continue;
        }
        const src = readFileSync(full, "utf8");
        // any arithmetic operator directly touching a *Cents identifier
        if (/[A-Za-z]Cents\s*[-+*/]|[-+*/]\s*[A-Za-z]*Cents/.test(src)) {
          offenders.push(full);
        }
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
  });

  it("34 template + section source files never import a repository or mongoose model", () => {
    const dir = "src/modules/email/templates";
    const offenders: string[] = [];
    const walk = (path: string): void => {
      for (const entry of readdirSync(path)) {
        const full = join(path, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith(".ts")) continue;
        const src = readFileSync(full, "utf8");
        // Runtime (value) imports only — `import type { BookingDocument }` is erased and is a
        // shape contract, not a DB dependency.
        const runtimeImports = src
          .split("\n")
          .filter((l) => /^\s*import\s/.test(l) && !/^\s*import\s+type\s/.test(l));
        if (
          runtimeImports.some((l) => /\.(repository|model)\.js["']/.test(l)) ||
          /\bmongoose\b/.test(src)
        ) {
          offenders.push(full);
        }
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
  });

  it("client-created copy never implies an account or login", () => {
    const email = renderClientCreatedEmail({ clientFirstName: "Dana", businessName: "Acme" });
    const lower = `${email.html}\n${email.text}`.toLowerCase();
    for (const forbidden of [
      "password",
      "log in",
      "login",
      "sign in",
      "activate your account",
      "verification code",
    ]) {
      expect(lower).not.toContain(forbidden);
    }
  });

  it("registry renders every Stage-B key", () => {
    expect(
      renderEmailTemplate("CLIENT_CREATED", { clientFirstName: "A", businessName: "B" }).subject,
    ).toBe("You've been added as a client");
    expect(renderEmailTemplate("BOOKING_CUSTOMER_CONFIRMED", bookingData()).subject).toBe(
      "Your Bookly booking is confirmed",
    );
    expect(renderEmailTemplate("BOOKING_OWNER_NEW_BOOKING", bookingData()).subject).toContain(
      "New booking received",
    );
    expect(renderEmailTemplate("BOOKING_FOR_CLIENT_CONFIRMED", bookingData()).subject).toBe(
      "An appointment has been booked for you",
    );
    expect(
      renderEmailTemplate("BOOKING_STAFF_CREATED_NOTIFICATION", {
        ...bookingData(),
        createdByLabel: "You created a booking",
      }).subject,
    ).toBe("Booking created");
  });
});
