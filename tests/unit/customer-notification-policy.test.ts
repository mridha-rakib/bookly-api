import { describe, expect, it } from "vitest";

import { CustomerNotificationPolicy } from "../../src/modules/notification/customer-notification-policy.js";
import {
  NOTIFICATION_PREFERENCE_DEFAULTS,
  resolveNotificationPreferences,
} from "../../src/modules/user/user.types.js";

describe("resolveNotificationPreferences", () => {
  it("applies product defaults when the sub-doc is absent", () => {
    expect(resolveNotificationPreferences(undefined)).toEqual(NOTIFICATION_PREFERENCE_DEFAULTS);
    expect(NOTIFICATION_PREFERENCE_DEFAULTS).toEqual({
      appointmentReminderEmail: true,
      appointmentReminderSms: false,
      marketingEmail: false,
    });
  });

  it("fills in only the missing channel, keeping the stored one", () => {
    expect(resolveNotificationPreferences({ appointmentReminderEmail: false })).toEqual({
      appointmentReminderEmail: false,
      appointmentReminderSms: false,
      marketingEmail: false,
    });
    expect(resolveNotificationPreferences({ appointmentReminderSms: true })).toEqual({
      appointmentReminderEmail: true,
      appointmentReminderSms: true,
      marketingEmail: false,
    });
  });

  it("defaults marketingEmail to false and echoes an explicit opt-in without touching reminders", () => {
    expect(resolveNotificationPreferences({}).marketingEmail).toBe(false);
    expect(resolveNotificationPreferences({ marketingEmail: true })).toEqual({
      appointmentReminderEmail: true,
      appointmentReminderSms: false,
      marketingEmail: true,
    });
    expect(resolveNotificationPreferences({ marketingEmail: false }).marketingEmail).toBe(false);
  });
});

describe("CustomerNotificationPolicy", () => {
  const policy = new CustomerNotificationPolicy();

  describe("mayReceiveAppointmentReminderEmail", () => {
    it("defaults to true and honours an explicit opt-out", () => {
      expect(policy.mayReceiveAppointmentReminderEmail(undefined)).toBe(true);
      expect(policy.mayReceiveAppointmentReminderEmail({ appointmentReminderEmail: true })).toBe(
        true,
      );
      expect(policy.mayReceiveAppointmentReminderEmail({ appointmentReminderEmail: false })).toBe(
        false,
      );
    });

    it("is unaffected by the marketingEmail preference", () => {
      expect(policy.mayReceiveAppointmentReminderEmail({ marketingEmail: true })).toBe(true);
      expect(
        policy.mayReceiveAppointmentReminderEmail({
          appointmentReminderEmail: false,
          marketingEmail: true,
        }),
      ).toBe(false);
    });
  });

  describe("mayReceiveMarketingEmail", () => {
    it("is false unless the customer has explicitly opted in", () => {
      expect(policy.mayReceiveMarketingEmail(undefined)).toBe(false);
      expect(policy.mayReceiveMarketingEmail({})).toBe(false);
      expect(policy.mayReceiveMarketingEmail({ marketingEmail: false })).toBe(false);
      expect(policy.mayReceiveMarketingEmail({ marketingEmail: true })).toBe(true);
    });

    it("is independent of the appointment-reminder preferences", () => {
      expect(
        policy.mayReceiveMarketingEmail({
          appointmentReminderEmail: false,
          appointmentReminderSms: true,
          marketingEmail: true,
        }),
      ).toBe(true);
      expect(
        policy.mayReceiveMarketingEmail({
          appointmentReminderEmail: true,
          appointmentReminderSms: true,
        }),
      ).toBe(false);
    });
  });

  describe("mayReceiveAppointmentReminderSms", () => {
    const verified = { e164: "+35799123456" };

    it("is false by default even with a verified phone (opt-in channel)", () => {
      expect(policy.mayReceiveAppointmentReminderSms(undefined, verified)).toBe(false);
    });

    it("requires BOTH the preference enabled AND a verified E.164 phone", () => {
      expect(
        policy.mayReceiveAppointmentReminderSms({ appointmentReminderSms: true }, verified),
      ).toBe(true);
      expect(
        policy.mayReceiveAppointmentReminderSms({ appointmentReminderSms: true }, undefined),
      ).toBe(false);
      expect(
        policy.mayReceiveAppointmentReminderSms({ appointmentReminderSms: true }, { e164: "" }),
      ).toBe(false);
      expect(
        policy.mayReceiveAppointmentReminderSms({ appointmentReminderSms: false }, verified),
      ).toBe(false);
    });
  });
});
