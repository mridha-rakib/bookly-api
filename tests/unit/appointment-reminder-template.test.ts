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
import {
  buildSessionEndReminderEmailData,
  renderSessionEndReminderEmail,
} from "../../src/modules/email/templates/booking/session-end-reminder.template.js";

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

describe("session-end reminder booking descriptions", () => {
  const base = booking as unknown as Record<string, unknown>;
  const line = (name: string, durationMin: number) => ({ serviceSnapshot: { name, durationMin } });

  it("preserves the single-service name and venue-local end time", () => {
    const data = buildSessionEndReminderEmailData(booking, { businessName: "Glow Studio" });
    const email = renderSessionEndReminderEmail(data);
    expect(data.endTime).toBe("12:45");
    expect(email.text).toContain("your session for Deep Tissue Massage");
    expect(email.html).toContain("Deep Tissue Massage");
  });

  it.each([
    [30, 60],
    [60, 60],
  ])("describes the booking end for parallel durations %i and %i", (first, second) => {
    const parallel = {
      ...base,
      serviceLines: [line("Short service", first), line("Other service", second)],
      schedule: {
        startAt: new Date("2026-09-10T09:00:00Z"),
        endAt: new Date("2026-09-10T10:00:00Z"),
        timezone: "Europe/Nicosia",
      },
    } as never;
    const data = buildSessionEndReminderEmailData(parallel, { businessName: "Glow Studio" });
    const email = renderSessionEndReminderEmail(data);
    expect(data.endTime).toBe("13:00");
    for (const body of [email.text, email.html]) {
      expect(body).toContain("your booking with Glow Studio is scheduled to end at 13:00");
      expect(body).not.toContain("Short service");
    }
  });

  it("uses the existing fallback when the optional service line is absent", () => {
    const data = buildSessionEndReminderEmailData({ ...base, serviceLines: [] } as never, {
      businessName: "Glow Studio",
    });
    expect(data.serviceName).toBe("your session");
    expect(renderSessionEndReminderEmail(data).text).toContain("12:45");
  });
});
