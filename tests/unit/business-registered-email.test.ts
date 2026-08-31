import { describe, expect, it, vi } from "vitest";

import {
  getEmailFooterLinks,
  INTERNAL_NOTIFICATION_RECIPIENTS,
} from "../../src/modules/email/email.config.js";
import { renderEmailTemplate } from "../../src/modules/email/template-registry.js";
import { renderBusinessRegisteredEmail } from "../../src/modules/email/templates/admin/business-registered.template.js";
import type { EmailOutboxService } from "../../src/modules/email-outbox/email-outbox.service.js";
import { BusinessRegisteredNotifier } from "../../src/modules/notification/business-registered.notifier.js";

/** MAILING STAGE D — business registration email + notifier (Part: registration 31–39; arch 44). */

const data = () => ({
  businessId: "6512aa000000000000000009",
  businessName: "Soho Vintage Barbers",
  ownerName: "Blake Owner",
  ownerEmail: "blake@example.com",
  phone: "+35799112233",
  category: "Wellness",
  city: "Larnaca",
  status: "PENDING",
  registeredAtFormatted: "Saturday, 5 September 2026",
});

describe("BUSINESS_REGISTERED email", () => {
  it("34/35/36 subject + body carry the real registration facts incl. persisted PENDING status", () => {
    const email = renderBusinessRegisteredEmail(data());
    expect(email.subject).toBe("New business registration — Soho Vintage Barbers");
    expect(email.text).toContain("Owner: Blake Owner");
    expect(email.text).toContain("Owner email: blake@example.com");
    expect(email.text).toContain("Phone: +35799112233");
    expect(email.text).toContain("Category: Wellness");
    expect(email.text).toContain("City: Larnaca");
    expect(email.text).toContain("Business ID: 6512aa000000000000000009");
    expect(email.text).toContain("Status: PENDING");
  });

  it("optional fields omit cleanly", () => {
    const email = renderBusinessRegisteredEmail({
      ...data(),
      phone: undefined,
      category: undefined,
      city: undefined,
    });
    expect(email.text).not.toContain("Phone:");
    expect(email.text).not.toContain("Category:");
    expect(email.text).not.toContain("City:");
  });

  it("38 no password / OTP / token leaked (only the fields we pass exist)", () => {
    const json = JSON.stringify(renderBusinessRegisteredEmail(data())).toLowerCase();
    for (const forbidden of ["password", "otp", "token", "secret", "passwordhash"]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("37/44 admin@bookly.cy is NEVER in the shared footer (or anywhere in this email)", () => {
    const email = renderBusinessRegisteredEmail(data());
    expect(JSON.stringify(getEmailFooterLinks())).not.toContain("admin@bookly.cy");
    expect(email.html).toContain("support@bookly.cy");
    expect(email.html).not.toContain("admin@bookly.cy");
    expect(email.text).not.toContain("admin@bookly.cy");
  });

  it("31/32/39 notifier enqueues one row per internal recipient, retry-safe, deterministic key", async () => {
    const enqueue = vi.fn().mockResolvedValue({ created: true, record: {} });
    const notifier = new BusinessRegisteredNotifier({ enqueue } as unknown as EmailOutboxService);

    const input = {
      businessId: "b-1",
      businessName: "Soho",
      ownerName: "Blake",
      ownerEmail: "blake@example.com",
      status: "PENDING",
      registeredAt: new Date("2026-09-05T10:00:00.000Z"),
    };
    await notifier.notifyBusinessRegistered(input);

    expect(enqueue).toHaveBeenCalledTimes(2);
    const recipients = enqueue.mock.calls.map((c) => c[0].recipient).sort();
    expect(recipients).toEqual(["admin@bookly.cy", "support@bookly.cy"]);
    for (const call of enqueue.mock.calls) {
      expect(call[0].eventKey).toBe("BUSINESS_REGISTERED:b-1");
      expect(call[0].templateKey).toBe("BUSINESS_REGISTERED");
    }
    expect(INTERNAL_NOTIFICATION_RECIPIENTS).toEqual(["admin@bookly.cy", "support@bookly.cy"]);
  });

  it("33 notifier swallows an enqueue error", async () => {
    const notifier = new BusinessRegisteredNotifier({
      enqueue: vi.fn().mockRejectedValue(new Error("db")),
    } as unknown as EmailOutboxService);
    await expect(
      notifier.notifyBusinessRegistered({
        businessId: "b",
        businessName: "S",
        ownerName: "B",
        ownerEmail: "b@e.com",
        status: "PENDING",
        registeredAt: new Date(),
      }),
    ).resolves.toBeUndefined();
  });

  it("registry renders BUSINESS_REGISTERED", () => {
    expect(renderEmailTemplate("BUSINESS_REGISTERED", data()).subject).toContain(
      "New business registration",
    );
  });
});
