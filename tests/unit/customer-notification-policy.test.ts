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
    });
  });

  it("fills in only the missing channel, keeping the stored one", () => {
    expect(resolveNotificationPreferences({ appointmentReminderEmail: false })).toEqual({
      appointmentReminderEmail: false,
      appointmentReminderSms: false,
    });
    expect(resolveNotificationPreferences({ appointmentReminderSms: true })).toEqual({
      appointmentReminderEmail: true,
      appointmentReminderSms: true,
    });
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
