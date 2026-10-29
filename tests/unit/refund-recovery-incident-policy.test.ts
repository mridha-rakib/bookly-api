import { describe, expect, it } from "vitest";
import { renderEmailTemplate } from "../../src/modules/email/template-registry.js";
import { parseRefundIncidentAlertPolicy } from "../../src/modules/payment/refund-recovery-incident.js";

describe("P5-F1 explicit incident alert policy", () => {
  it("has no implicit thresholds or recipient fallback", () => {
    expect(parseRefundIncidentAlertPolicy({})).toBeUndefined();
  });
  it("requires a complete valid policy and never prints invalid configuration values", () => {
    for (const config of [
      { BOOKLY_REFUND_INCIDENT_ALERT_RECIPIENTS: "private@example.com" },
      {
        BOOKLY_REFUND_INCIDENT_ALERT_RECIPIENTS: "secret-value",
        BOOKLY_REFUND_INCIDENT_ALERT_MIN_OBSERVATIONS: "2",
        BOOKLY_REFUND_INCIDENT_ALERT_MIN_AGE_MS: "0",
      },
      {
        BOOKLY_REFUND_INCIDENT_ALERT_RECIPIENTS: "private@example.com",
        BOOKLY_REFUND_INCIDENT_ALERT_MIN_OBSERVATIONS: "0",
        BOOKLY_REFUND_INCIDENT_ALERT_MIN_AGE_MS: "-1",
      },
    ]) {
      expect(() => parseRefundIncidentAlertPolicy(config)).toThrow(
        /Refund incident alert configuration/,
      );
      try {
        parseRefundIncidentAlertPolicy(config);
      } catch (error) {
        expect(String(error)).not.toContain("private@example.com");
        expect(String(error)).not.toContain("secret-value");
      }
    }
  });
  it("normalizes/deduplicates explicit destinations and accepts explicit zero age", () => {
    expect(
      parseRefundIncidentAlertPolicy({
        BOOKLY_REFUND_INCIDENT_ALERT_RECIPIENTS: "Ops@Example.com,ops@example.com",
        BOOKLY_REFUND_INCIDENT_ALERT_MIN_OBSERVATIONS: "2",
        BOOKLY_REFUND_INCIDENT_ALERT_MIN_AGE_MS: "0",
      }),
    ).toEqual({ recipients: ["ops@example.com"], minObservations: 2, minAgeMs: 0 });
  });
  it("reuses the registered finance alert template without claiming money moved", () => {
    const email = renderEmailTemplate("FINANCE_SUPPORT_ALERT", {
      kind: "REFUND_RECOVERY_CONFLICT",
      providerReference: "RefundOperation test-only",
    });
    expect(email.subject).toContain("Refund recovery requires investigation");
    expect(email.text).toContain("does not authorize a refund or financial change");
  });
});
