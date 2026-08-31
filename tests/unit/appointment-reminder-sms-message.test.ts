import { describe, expect, it } from "vitest";

import { buildAppointmentReminderSmsMessage } from "../../src/modules/sms/appointment-reminder-sms-message.js";

describe("buildAppointmentReminderSmsMessage", () => {
  const input = {
    businessName: "Glow Studio",
    appointmentDate: "Thu 10 Sep",
    appointmentTime: "12:00",
    venueTimezone: "Europe/Nicosia",
  };

  it("is a pure single-line string mentioning Bookly, the business, and the venue-tz time", () => {
    const msg = buildAppointmentReminderSmsMessage(input);
    expect(msg).toContain("Bookly");
    expect(msg).toContain("Glow Studio");
    expect(msg).toContain("Thu 10 Sep");
    expect(msg).toContain("12:00");
    expect(msg).toContain("Europe/Nicosia");
    expect(msg).not.toContain("\n");
    // deterministic
    expect(buildAppointmentReminderSmsMessage(input)).toBe(msg);
  });

  it("carries no payment data, tokens, links with tokens, or PII beyond the business + time", () => {
    const msg = buildAppointmentReminderSmsMessage(input).toLowerCase();
    expect(msg).not.toMatch(/deposit|balance|€|\$|token=|otp|password|http:\/\/|https:\/\//);
  });
});
