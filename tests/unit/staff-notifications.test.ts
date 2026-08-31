import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import { renderEmailTemplate } from "../../src/modules/email/template-registry.js";
import { renderStaffAccessRemovedEmail } from "../../src/modules/email/templates/staff/staff-access-removed.template.js";
import { renderStaffBookingCancelledEmail } from "../../src/modules/email/templates/staff/staff-booking-cancelled.template.js";
import { renderStaffBookingScheduleChangedEmail } from "../../src/modules/email/templates/staff/staff-booking-schedule-changed.template.js";
import { StaffAccessNotifier } from "../../src/modules/notification/staff-access.notifier.js";
import { StaffBookingNotifier } from "../../src/modules/notification/staff-booking.notifier.js";
import { resolveAssignedStaffRecipients } from "../../src/modules/notification/staff-booking-recipients.js";
import { buildBooking } from "./stage-b-fixtures.js";

/**
 * IMPORTANT STAFF EMAIL NOTIFICATIONS — unit coverage for the 3 implemented triggers:
 * STAFF_BOOKING_CANCELLED, STAFF_BOOKING_SCHEDULE_CHANGED, STAFF_ACCESS_REMOVED.
 * Template rendering, recipient resolution, notifier mapping, and the safe-skip paths.
 */

const outboxStub = () => {
  const enqueue = vi.fn().mockResolvedValue({ created: true });
  return { enqueue };
};

/** Staff port: each membership id maps 1:1 to a synthetic user id via `userIdFor`. */
const staffPort = (userIdFor: (membershipId: string) => string | null) => ({
  findManyByIdsForBusiness: vi.fn(
    async (_businessId: unknown, ids: Array<string | Types.ObjectId>) =>
      ids
        .map((id) => {
          const userId = userIdFor(String(id));
          return userId ? { _id: String(id), userId } : null;
        })
        .filter((m): m is { _id: string; userId: string } => m !== null),
  ),
});

const userPort = (
  emailByUserId: Record<string, string | undefined>,
  firstNameByUserId: Record<string, string> = {},
) => ({
  findManyByIds: vi.fn(async (ids: Array<string | Types.ObjectId>) =>
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

describe("staff notification templates", () => {
  it("STAFF_BOOKING_CANCELLED renders branded HTML + text with the operational facts, no money, no CTA", () => {
    const email = renderStaffBookingCancelledEmail({
      staffFirstName: "Sam",
      bookingReference: "BK-7F3K9QZC",
      businessName: "Soho Vintage Barbers",
      customerName: "Dana Klein",
      appointmentDate: "Friday, 5 September 2026",
      appointmentTime: "12:00",
      services: ["Haircut", "Beard trim"],
      cancelledBy: "CUSTOMER",
    });

    expect(email.subject).toBe("A booking assigned to you was cancelled");
    for (const needle of [
      "Sam",
      "BK-7F3K9QZC",
      "Soho Vintage Barbers",
      "Dana Klein",
      "Friday, 5 September 2026",
      "12:00",
      "Haircut, Beard trim",
      "the customer",
    ]) {
      expect(email.html).toContain(needle);
      expect(email.text).toContain(needle);
    }
    // branded shell
    expect(email.html).toContain("cid:bookly-wordmark");
    expect(email.html).toContain("Privacy Policy");
    expect(email.html).toContain("support@bookly.cy");
    // operational only — never financial, never a fabricated staff booking link
    const haystack = `${email.html}\n${email.text}`.toLowerCase();
    for (const forbidden of [
      "refund",
      "deposit",
      "fee",
      "/staff/bookings",
      "/professional/bookings",
      "view booking",
    ]) {
      expect(haystack).not.toContain(forbidden);
    }
  });

  it("STAFF_BOOKING_SCHEDULE_CHANGED shows previous vs new appointment, no CTA", () => {
    const email = renderStaffBookingScheduleChangedEmail({
      staffFirstName: "Sam",
      bookingReference: "BK-7F3K9QZC",
      businessName: "Soho Vintage Barbers",
      customerName: "Dana Klein",
      previousDate: "Friday, 5 September 2026",
      previousTime: "12:00",
      newDate: "Monday, 8 September 2026",
      newTime: "15:30",
      services: ["Haircut"],
    });

    expect(email.subject).toBe("A booking assigned to you was rescheduled");
    for (const needle of [
      "Friday, 5 September 2026",
      "12:00",
      "Monday, 8 September 2026",
      "15:30",
    ]) {
      expect(email.html).toContain(needle);
      expect(email.text).toContain(needle);
    }
    expect(email.html).toContain("cid:bookly-wordmark");
    expect(`${email.html}${email.text}`.toLowerCase()).not.toContain("view booking");
  });

  it("STAFF_ACCESS_REMOVED states only the fact, invents no reason, keeps login note", () => {
    const email = renderStaffAccessRemovedEmail({
      staffFirstName: "Sam",
      businessName: "Soho Vintage Barbers",
    });
    expect(email.subject).toBe("Your team access has been removed");
    expect(email.html).toContain("Soho Vintage Barbers");
    expect(email.html).toContain("login itself still works");
    expect(email.text).toContain("login itself still works");
    const haystack = `${email.html}\n${email.text}`.toLowerCase();
    for (const forbidden of ["password", "reason:", "because", "violation"]) {
      expect(haystack).not.toContain(forbidden);
    }
  });

  it("escapes HTML metacharacters in dynamic values", () => {
    const email = renderStaffBookingCancelledEmail({
      staffFirstName: "<b>Sam</b>",
      bookingReference: "BK & CO",
      businessName: "A <script>",
      customerName: 'D"K',
      appointmentDate: "d",
      appointmentTime: "t",
      services: [],
      cancelledBy: "BUSINESS",
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("&amp;");
  });

  it("every new template carries the standard branded shell (header + footer links + support)", () => {
    const rendered = [
      renderStaffAccessRemovedEmail({ staffFirstName: "Sam", businessName: "Soho" }),
      renderStaffBookingCancelledEmail({
        staffFirstName: "Sam",
        bookingReference: "BK",
        businessName: "Soho",
        customerName: "Dana",
        appointmentDate: "d",
        appointmentTime: "t",
        services: ["Haircut"],
        cancelledBy: "CUSTOMER",
      }),
      renderStaffBookingScheduleChangedEmail({
        staffFirstName: "Sam",
        bookingReference: "BK",
        businessName: "Soho",
        customerName: "Dana",
        previousDate: "d",
        previousTime: "t",
        newDate: "d2",
        newTime: "t2",
        services: ["Haircut"],
      }),
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

  it("all 3 keys are wired into the shared template registry", () => {
    expect(() =>
      renderEmailTemplate("STAFF_ACCESS_REMOVED", {
        staffFirstName: "Sam",
        businessName: "Soho",
      }),
    ).not.toThrow();
    expect(() =>
      renderEmailTemplate("STAFF_BOOKING_CANCELLED", {
        staffFirstName: "Sam",
        bookingReference: "BK",
        businessName: "Soho",
        customerName: "Dana",
        appointmentDate: "d",
        appointmentTime: "t",
        services: [],
        cancelledBy: "CUSTOMER",
      }),
    ).not.toThrow();
    expect(() =>
      renderEmailTemplate("STAFF_BOOKING_SCHEDULE_CHANGED", {
        staffFirstName: "Sam",
        bookingReference: "BK",
        businessName: "Soho",
        customerName: "Dana",
        previousDate: "d",
        previousTime: "t",
        newDate: "d2",
        newTime: "t2",
        services: [],
      }),
    ).not.toThrow();
  });
});

describe("resolveAssignedStaffRecipients", () => {
  it("returns one recipient per DISTINCT assigned staff, with their own service names", async () => {
    const m1 = new Types.ObjectId();
    const m2 = new Types.ObjectId();
    const booking = buildBooking({
      serviceLines: [
        {
          serviceId: new Types.ObjectId(),
          serviceSnapshot: { name: "Haircut", pricingMode: "FIXED", durationMin: 30 },
          pricingInput: {},
          responsibleStaffMembershipId: m1,
          staffSnapshot: { firstName: "Sam" },
          addons: [],
          amountCents: 3000,
          reservationId: new Types.ObjectId(),
        },
        {
          serviceId: new Types.ObjectId(),
          serviceSnapshot: { name: "Colour", pricingMode: "FIXED", durationMin: 60 },
          pricingInput: {},
          responsibleStaffMembershipId: m2,
          staffSnapshot: { firstName: "Riley" },
          addons: [],
          amountCents: 6000,
          reservationId: new Types.ObjectId(),
        },
      ],
    } as never);

    const staff = staffPort((id) => (id === String(m1) ? "u1" : id === String(m2) ? "u2" : null));
    const users = userPort(
      { u1: "sam@example.com", u2: "riley@example.com" },
      { u1: "Sam", u2: "Riley" },
    );

    const recipients = await resolveAssignedStaffRecipients(booking, staff, users);
    expect(recipients).toHaveLength(2);
    expect(recipients.map((r) => r.email).sort()).toEqual(["riley@example.com", "sam@example.com"]);
    expect(recipients.find((r) => r.email === "sam@example.com")?.services).toEqual(["Haircut"]);
    expect(recipients.find((r) => r.email === "riley@example.com")?.services).toEqual(["Colour"]);
  });

  it("drops a membership whose email cannot be resolved", async () => {
    const booking = buildBooking();
    const membershipId = String(booking.serviceLines[0]?.responsibleStaffMembershipId);
    const staff = staffPort(() => "u1");
    const users = userPort({ u1: undefined }); // no email on file

    const recipients = await resolveAssignedStaffRecipients(booking, staff, users);
    expect(recipients).toEqual([]);
    expect(staff.findManyByIdsForBusiness).toHaveBeenCalledWith(booking.businessId, [membershipId]);
  });
});

describe("StaffBookingNotifier", () => {
  it("cancellation enqueues one STAFF_BOOKING_CANCELLED row per assigned staff, terminal eventKey", async () => {
    const booking = buildBooking();
    const membershipId = String(booking.serviceLines[0]?.responsibleStaffMembershipId);
    const outbox = outboxStub();
    const notifier = new StaffBookingNotifier(
      outbox,
      staffPort(() => "u1"),
      userPort({ u1: "sam@example.com" }, { u1: "Sam" }),
    );

    await notifier.notifyBookingCancelledToStaff(booking, "Soho", "CUSTOMER");

    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: `BOOKING_CANCELLED:${String(booking._id)}`,
        templateKey: "STAFF_BOOKING_CANCELLED",
        recipient: "sam@example.com",
      }),
    );
    expect(membershipId).toBeTruthy();
  });

  it("cancellation with no resolvable assigned-staff email enqueues nothing and does not throw", async () => {
    const booking = buildBooking();
    const outbox = outboxStub();
    const notifier = new StaffBookingNotifier(
      outbox,
      staffPort(() => "u1"),
      userPort({ u1: undefined }),
    );

    await expect(
      notifier.notifyBookingCancelledToStaff(booking, "Soho", "BUSINESS"),
    ).resolves.toBeUndefined();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it("a thrown port error is swallowed (never undoes the cancellation)", async () => {
    const booking = buildBooking();
    const outbox = outboxStub();
    const brokenStaff = {
      findManyByIdsForBusiness: vi.fn().mockRejectedValue(new Error("db down")),
    };
    const notifier = new StaffBookingNotifier(outbox, brokenStaff, userPort({}));
    await expect(
      notifier.notifyBookingCancelledToStaff(booking, "Soho", "CUSTOMER"),
    ).resolves.toBeUndefined();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it("reschedule uses the last history entry and a monotonic history-length eventKey", async () => {
    const previousStart = new Date("2026-09-05T09:00:00.000Z");
    const newStart = new Date("2026-09-08T12:30:00.000Z");
    const booking = buildBooking({
      schedule: { timezone: "Europe/Nicosia", startAt: newStart, endAt: newStart },
      rescheduleHistory: [
        {
          actorUserId: new Types.ObjectId(),
          actorRole: "CUSTOMER",
          previousStart,
          previousEnd: previousStart,
          newStart,
          newEnd: newStart,
          countedTowardCustomerQuota: true,
          createdAt: new Date(),
        },
      ],
    } as never);
    const outbox = outboxStub();
    const notifier = new StaffBookingNotifier(
      outbox,
      staffPort(() => "u1"),
      userPort({ u1: "sam@example.com" }, { u1: "Sam" }),
    );

    await notifier.notifyBookingRescheduledToStaff(booking, "Soho");

    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: `BOOKING_SCHEDULE_CHANGED:${String(booking._id)}:1`,
        templateKey: "STAFF_BOOKING_SCHEDULE_CHANGED",
        recipient: "sam@example.com",
      }),
    );
  });

  it("reschedule with no history entry, or a no-op time move, enqueues nothing", async () => {
    const outbox = outboxStub();
    const notifier = new StaffBookingNotifier(
      outbox,
      staffPort(() => "u1"),
      userPort({ u1: "sam@example.com" }),
    );

    await notifier.notifyBookingRescheduledToStaff(buildBooking({ rescheduleHistory: [] }), "Soho");

    const sameInstant = new Date("2026-09-05T09:00:00.000Z");
    await notifier.notifyBookingRescheduledToStaff(
      buildBooking({
        rescheduleHistory: [
          {
            actorUserId: new Types.ObjectId(),
            actorRole: "OWNER",
            previousStart: sameInstant,
            previousEnd: sameInstant,
            newStart: sameInstant,
            newEnd: sameInstant,
            countedTowardCustomerQuota: false,
            createdAt: new Date(),
          },
        ],
      } as never),
      "Soho",
    );

    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});

describe("StaffAccessNotifier", () => {
  it("enqueues STAFF_ACCESS_REMOVED with a membership-scoped eventKey", async () => {
    const membershipId = new Types.ObjectId().toString();
    const outbox = outboxStub();
    const notifier = new StaffAccessNotifier(
      outbox,
      userPort({ u9: "removed@example.com" }, { u9: "Alex" }),
    );

    await notifier.notifyStaffRemoved({ membershipId, userId: "u9", businessName: "Soho" });

    expect(outbox.enqueue).toHaveBeenCalledWith({
      eventKey: `STAFF_ACCESS_REMOVED:${membershipId}`,
      templateKey: "STAFF_ACCESS_REMOVED",
      recipient: "removed@example.com",
      payload: { staffFirstName: "Alex", businessName: "Soho" },
    });
  });

  it("skips silently when the removed user has no email, and never throws on port failure", async () => {
    const outbox = outboxStub();
    const noEmail = new StaffAccessNotifier(outbox, userPort({ u9: undefined }));
    await noEmail.notifyStaffRemoved({ membershipId: "m", userId: "u9", businessName: "Soho" });
    expect(outbox.enqueue).not.toHaveBeenCalled();

    const broken = new StaffAccessNotifier(outbox, {
      findManyByIds: vi.fn().mockRejectedValue(new Error("down")),
      findProfilesByUserIds: vi.fn().mockResolvedValue([]),
    });
    await expect(
      broken.notifyStaffRemoved({ membershipId: "m", userId: "u9", businessName: "Soho" }),
    ).resolves.toBeUndefined();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});
