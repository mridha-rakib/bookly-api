import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { EmailOutboxModel } from "../../../src/modules/email-outbox/email-outbox.model.js";
import { EmailOutboxRepository } from "../../../src/modules/email-outbox/email-outbox.repository.js";
import { EmailOutboxService } from "../../../src/modules/email-outbox/email-outbox.service.js";
import { BookingCancelledNotifier } from "../../../src/modules/notification/booking-cancelled.notifier.js";
import { BusinessRegisteredNotifier } from "../../../src/modules/notification/business-registered.notifier.js";
import { NoShowNotifier } from "../../../src/modules/notification/no-show.notifier.js";
import {
  buildBusiness,
  buildCancelledBooking,
  buildNoShowBooking,
  NO_SHOW_CHARGED_AMOUNTS,
} from "../../unit/stage-d-fixtures.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/**
 * MAILING STAGE D — every Stage-D notification goes through the real Stage-A EmailOutbox:
 * PENDING rows (async), deterministic keys, DB-level dedupe on a retried domain operation.
 * Part: arch 40, 49, 50; cancellation 14; no-show 30; registration 39.
 */
describe("Stage D notifications → EmailOutbox integration", () => {
  let outbox: EmailOutboxService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    outbox = new EmailOutboxService(new EmailOutboxRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  it("14 cancellation: retried cancel enqueues exactly 2 PENDING rows (customer + owner)", async () => {
    const business = buildBusiness();
    const booking = buildCancelledBooking({}, { businessId: business._id });
    const notifier = new BookingCancelledNotifier(outbox, {
      findManyByIds: async () => [
        { _id: business.ownerUserId, normalizedEmail: "owner@example.com" },
      ],
    });

    await notifier.notifyBookingCancelled(booking, business, "CUSTOMER");
    await notifier.notifyBookingCancelled(booking, business, "CUSTOMER");

    const rows = await EmailOutboxModel.find({}).lean();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "PENDING")).toBe(true);
    expect(rows.map((r) => r.templateKey).sort()).toEqual([
      "BOOKING_CANCELLED_CUSTOMER",
      "BOOKING_CANCELLED_OWNER",
    ]);
    expect(rows.every((r) => r.eventKey === `BOOKING_CANCELLED:${String(booking._id)}`)).toBe(true);
  });

  it("30 no-show: retried CHARGED enqueues exactly one PENDING row", async () => {
    const booking = buildNoShowBooking("NO_SHOW_CHARGED");
    const notifier = new NoShowNotifier(outbox);

    await notifier.notifyNoShowCharged(booking, {
      businessName: "Soho",
      amounts: NO_SHOW_CHARGED_AMOUNTS,
    });
    await notifier.notifyNoShowCharged(booking, {
      businessName: "Soho",
      amounts: NO_SHOW_CHARGED_AMOUNTS,
    });

    const rows = await EmailOutboxModel.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("PENDING");
    expect(rows[0]?.dedupeKey).toBe(
      `NO_SHOW_CHARGED:${String(booking._id)}::NO_SHOW_CHARGED::dana@example.com`,
    );
  });

  it("no-show WAIVED and CANCELLED for one booking are separate rows and each retry-safe", async () => {
    const booking = buildNoShowBooking("NO_SHOW_WAIVED");
    const notifier = new NoShowNotifier(outbox);
    await notifier.notifyNoShowWaived(booking, { businessName: "Soho" });
    await notifier.notifyNoShowCancelled(booking, { businessName: "Soho" });
    await notifier.notifyNoShowWaived(booking, { businessName: "Soho" });

    const rows = await EmailOutboxModel.find({}).lean();
    expect(rows.map((r) => r.templateKey).sort()).toEqual(["NO_SHOW_CANCELLED", "NO_SHOW_WAIVED"]);
  });

  it("39 registration: retried registration enqueues admin + support, once each", async () => {
    const notifier = new BusinessRegisteredNotifier(outbox);
    const input = {
      businessId: new Types.ObjectId().toString(),
      businessName: "Soho",
      ownerName: "Blake",
      ownerEmail: "blake@example.com",
      status: "PENDING",
      registeredAt: new Date("2026-09-05T10:00:00.000Z"),
    };

    await notifier.notifyBusinessRegistered(input);
    await notifier.notifyBusinessRegistered(input);

    const rows = await EmailOutboxModel.find({}).lean();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.recipient).sort()).toEqual(["admin@bookly.cy", "support@bookly.cy"]);
    expect(rows.every((r) => r.status === "PENDING")).toBe(true);
    const json = JSON.stringify(rows).toLowerCase();
    for (const forbidden of ["password", "otp", "token", "secret"]) {
      expect(json).not.toContain(forbidden);
    }
  });
});
