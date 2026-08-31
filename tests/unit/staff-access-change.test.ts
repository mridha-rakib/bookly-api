import { describe, expect, it, vi } from "vitest";
import { renderEmailTemplate } from "../../src/modules/email/template-registry.js";
import { renderStaffDeactivatedEmail } from "../../src/modules/email/templates/staff/staff-deactivated.template.js";
import { renderStaffReactivatedEmail } from "../../src/modules/email/templates/staff/staff-reactivated.template.js";
import { renderStaffRoleChangedEmail } from "../../src/modules/email/templates/staff/staff-role-changed.template.js";
import {
  type StaffAccessChangePresentation,
  StaffAccessNotifier,
} from "../../src/modules/notification/staff-access.notifier.js";

/**
 * STAFF ACCESS CHANGE — unit coverage for the ROLE_CHANGED / DEACTIVATED / REACTIVATED
 * templates and the `StaffAccessNotifier.notifyStaffAccessChanged` mapping (event id → one
 * outbox row, role-label mapping, safe-skip on missing email, never throws).
 */

const outboxStub = () => ({ enqueue: vi.fn().mockResolvedValue({ created: true }) });

const userPort = (
  emailByUserId: Record<string, string | undefined>,
  firstNameByUserId: Record<string, string> = {},
) => ({
  findManyByIds: vi.fn(async (ids: Array<string>) =>
    ids
      .map((id) => {
        const email = emailByUserId[String(id)];
        return email ? { _id: String(id), normalizedEmail: email } : null;
      })
      .filter((u): u is { _id: string; normalizedEmail: string } => u !== null),
  ),
  findProfilesByUserIds: vi.fn(async (ids: string[]) =>
    ids.map((id) => ({
      userId: id,
      firstName: firstNameByUserId[id] ?? "Sam",
      lastName: "Cutter",
    })),
  ),
});

describe("staff access-change templates", () => {
  it("STAFF_ROLE_CHANGED prints both persisted role labels, no permission internals, no CTA", () => {
    const email = renderStaffRoleChangedEmail({
      staffFirstName: "Sam",
      businessName: "Soho Vintage Barbers",
      previousRole: "Staff",
      newRole: "Supervisor",
    });
    expect(email.subject).toBe("Your role at Bookly has changed");
    for (const needle of [
      "Sam",
      "Soho Vintage Barbers",
      "Previous role: Staff",
      "New role: Supervisor",
    ]) {
      expect(email.html).toContain(needle);
      expect(email.text).toContain(needle);
    }
    expect(email.html).toContain("cid:bookly-wordmark");
    expect(email.html).toContain("support@bookly.cy");
    const haystack = `${email.html}\n${email.text}`.toLowerCase();
    for (const forbidden of [
      "permission",
      "scope",
      "/staff-dashboard",
      "view dashboard",
      "log in here",
      "password",
    ]) {
      expect(haystack).not.toContain(forbidden);
    }
  });

  it("STAFF_DEACTIVATED never implies deletion / ban / suspension and invents no reason", () => {
    const email = renderStaffDeactivatedEmail({
      staffFirstName: "Sam",
      businessName: "Soho",
    });
    expect(email.subject).toBe("Your access to Bookly has been deactivated");
    expect(email.html).toContain("has been deactivated");
    expect(email.text).toContain("has been deactivated");
    const haystack = `${email.html}\n${email.text}`.toLowerCase();
    for (const forbidden of [
      "deleted",
      "banned",
      "suspended",
      "terminated",
      "reason:",
      "because",
      "password",
      "otp",
    ]) {
      expect(haystack).not.toContain(forbidden);
    }
  });

  it("STAFF_REACTIVATED says existing account, no new password, no onboarding", () => {
    const email = renderStaffReactivatedEmail({ staffFirstName: "Sam", businessName: "Soho" });
    expect(email.subject).toBe("Your access to Bookly has been restored");
    expect(email.html).toContain("existing Bookly staff account");
    const haystack = `${email.html}\n${email.text}`.toLowerCase();
    for (const forbidden of [
      "temporary password",
      "new password",
      "set up your account",
      "onboarding",
      "otp",
    ]) {
      expect(haystack).not.toContain(forbidden);
    }
  });

  it("every template carries the branded shell + text fallback, no admin address", () => {
    const rendered = [
      renderStaffRoleChangedEmail({
        staffFirstName: "Sam",
        businessName: "Soho",
        previousRole: "Supervisor",
        newRole: "Staff",
      }),
      renderStaffDeactivatedEmail({ staffFirstName: "Sam", businessName: "Soho" }),
      renderStaffReactivatedEmail({ staffFirstName: "Sam", businessName: "Soho" }),
    ];
    for (const email of rendered) {
      expect(email.html).toContain("cid:bookly-wordmark");
      expect(email.html).toContain("Contact Us");
      expect(email.html).toContain("Privacy Policy");
      expect(email.html).toContain("Terms and Conditions");
      expect(email.html).toContain("support@bookly.cy");
      expect(email.html).not.toContain("admin@bookly.cy");
      expect((email.attachments ?? []).some((a) => a.contentId === "bookly-wordmark")).toBe(true);
      expect(email.text.trim().length).toBeGreaterThan(60);
      expect(email.text).not.toMatch(/undefined|NaN|\[object Object\]|<[a-z]+>/i);
    }
  });

  it("escapes HTML metacharacters in dynamic values", () => {
    const email = renderStaffRoleChangedEmail({
      staffFirstName: "<b>Sam</b>",
      businessName: "A <script>alert(1)</script>",
      previousRole: "Staff & Co",
      newRole: 'Super"visor',
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("&amp;");
  });

  it("all 3 keys resolve through the shared registry", () => {
    for (const [key, payload] of [
      [
        "STAFF_ROLE_CHANGED",
        { staffFirstName: "S", businessName: "B", previousRole: "Staff", newRole: "Supervisor" },
      ],
      ["STAFF_DEACTIVATED", { staffFirstName: "S", businessName: "B" }],
      ["STAFF_REACTIVATED", { staffFirstName: "S", businessName: "B" }],
    ] as const) {
      expect(() => renderEmailTemplate(key, payload)).not.toThrow();
    }
  });
});

describe("StaffAccessNotifier.notifyStaffAccessChanged", () => {
  const base = (over: Partial<StaffAccessChangePresentation>): StaffAccessChangePresentation => ({
    eventId: "evt_1",
    type: "ROLE_CHANGED",
    staffUserId: "u1",
    businessName: "Soho",
    previousRole: "STAFF",
    newRole: "SUPERVISOR",
    ...over,
  });

  it("ROLE_CHANGED → one row, event-id key, persisted enum mapped to a label", async () => {
    const outbox = outboxStub();
    const notifier = new StaffAccessNotifier(
      outbox,
      userPort({ u1: "sam@example.com" }, { u1: "Sam" }),
    );

    await notifier.notifyStaffAccessChanged(base({ eventId: "evt_role_9" }));

    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).toHaveBeenCalledWith({
      eventKey: "STAFF_ROLE_CHANGED:evt_role_9",
      templateKey: "STAFF_ROLE_CHANGED",
      recipient: "sam@example.com",
      payload: {
        staffFirstName: "Sam",
        businessName: "Soho",
        previousRole: "Staff",
        newRole: "Supervisor",
      },
    });
  });

  it("DEACTIVATED / REACTIVATED → one row each with their own event-id key and minimal payload", async () => {
    const outbox = outboxStub();
    const notifier = new StaffAccessNotifier(
      outbox,
      userPort({ u1: "sam@example.com" }, { u1: "Sam" }),
    );

    await notifier.notifyStaffAccessChanged(base({ type: "DEACTIVATED", eventId: "evt_d" }));
    await notifier.notifyStaffAccessChanged(base({ type: "REACTIVATED", eventId: "evt_r" }));

    expect(outbox.enqueue).toHaveBeenNthCalledWith(1, {
      eventKey: "STAFF_DEACTIVATED:evt_d",
      templateKey: "STAFF_DEACTIVATED",
      recipient: "sam@example.com",
      payload: { staffFirstName: "Sam", businessName: "Soho" },
    });
    expect(outbox.enqueue).toHaveBeenNthCalledWith(2, {
      eventKey: "STAFF_REACTIVATED:evt_r",
      templateKey: "STAFF_REACTIVATED",
      recipient: "sam@example.com",
      payload: { staffFirstName: "Sam", businessName: "Soho" },
    });
  });

  it("skips silently when the affected staff has no email; never throws on port failure", async () => {
    const outbox = outboxStub();
    const noEmail = new StaffAccessNotifier(outbox, userPort({ u1: undefined }));
    await noEmail.notifyStaffAccessChanged(base({}));
    expect(outbox.enqueue).not.toHaveBeenCalled();

    const broken = new StaffAccessNotifier(outbox, {
      findManyByIds: vi.fn().mockRejectedValue(new Error("db down")),
      findProfilesByUserIds: vi.fn().mockResolvedValue([]),
    });
    await expect(broken.notifyStaffAccessChanged(base({}))).resolves.toBeUndefined();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});
