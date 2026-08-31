import { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import {
  isEmailTemplateRegistered,
  renderEmailTemplate,
} from "../../src/modules/email/template-registry.js";
import {
  buildAppointmentReminderEmailData,
  renderAppointmentReminder24hEmail,
} from "../../src/modules/email/templates/booking/appointment-reminder-24h.template.js";

const booking = {
  _id: new Types.ObjectId(),
  reference: "BK-9F3K2Q",
  schedule: {
    // 09:00 UTC == 12:00 in Europe/Nicosia (UTC+3 in September)
    startAt: new Date("2026-09-10T09:00:00.000Z"),
    endAt: new Date("2026-09-10T09:45:00.000Z"),
    timezone: "Europe/Nicosia",
  },
  customer: { contact: { firstName: "Jane" } },
  serviceLines: [
    {
      serviceSnapshot: { name: "Deep Tissue Massage", durationMin: 45 },
      staffSnapshot: { firstName: "Maria", lastName: "K." },
    },
  ],
  fulfilment: {
    mode: "AT_BUSINESS_LOCATION",
    businessLocation: {
      streetNumber: "12",
      streetName: "Makariou Ave",
      area: "Centre",
      city: "NICOSIA",
    },
  },
} as never;

describe("APPOINTMENT_REMINDER_24H template", () => {
  it("formats the appointment time in the booking's own timezone (not UTC, not browser)", () => {
    const data = buildAppointmentReminderEmailData(booking, { businessName: "Glow Studio" });
    expect(data.appointmentTime).toBe("12:00"); // Europe/Nicosia local, from 09:00Z
    expect(data.venueTimezone).toBe("Europe/Nicosia");
    expect(data.durationMin).toBe(45);
    expect(data.customerBookingUrlPath).toContain("/customer/bookings/view?id=");
  });

  it("renders subject/html/text and carries NO payment data or tokens", () => {
    const data = buildAppointmentReminderEmailData(booking, { businessName: "Glow Studio" });
    const rendered = renderAppointmentReminder24hEmail(data);

    expect(rendered.subject).toMatch(/reminder/i);
    expect(rendered.html).toContain("Glow Studio");
    expect(rendered.html).toContain("BK-9F3K2Q");
    expect(rendered.text).toContain("12:00");
    // no money / deposit / balance wording anywhere
    expect(rendered.html.toLowerCase()).not.toMatch(/deposit|balance|paid online|€/);
    expect(rendered.text.toLowerCase()).not.toMatch(/deposit|balance|paid online|€/);
    // no token-bearing query params
    expect(rendered.html).not.toMatch(/token=|otp=/i);
  });

  it("is wired into the shared template registry", () => {
    expect(isEmailTemplateRegistered("APPOINTMENT_REMINDER_24H")).toBe(true);
    const data = buildAppointmentReminderEmailData(booking, { businessName: "Glow Studio" });
    expect(() => renderEmailTemplate("APPOINTMENT_REMINDER_24H", data)).not.toThrow();
  });
});
