import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { EmailOutboxModel } from "../../../src/modules/email-outbox/email-outbox.model.js";
import { EmailOutboxRepository } from "../../../src/modules/email-outbox/email-outbox.repository.js";
import { EmailOutboxService } from "../../../src/modules/email-outbox/email-outbox.service.js";
import { BookingCreatedNotifier } from "../../../src/modules/notification/booking-created.notifier.js";
import { ClientCreatedNotifier } from "../../../src/modules/notification/client-created.notifier.js";
import { buildBooking, buildBusiness } from "../../unit/stage-b-fixtures.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/**
 * MAILING STAGE B — the notifiers go through the real Stage-A EmailOutbox. Proves: deterministic
 * event keys, DB-level dedupe on a retried domain operation, and that every Stage-B mail is
 * queued (PENDING) rather than sent inline. Part T items 5, 22, 23, 24.
 */
describe("Stage B notifications → EmailOutbox integration", () => {
  let outboxService: EmailOutboxService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    outboxService = new EmailOutboxService(new EmailOutboxRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  it("5 CLIENT_CREATED: a retried client creation does not create a duplicate outbox row", async () => {
    const notifier = new ClientCreatedNotifier(outboxService);
    const clientId = new Types.ObjectId().toString();
    const input = {
      clientId,
      clientFirstName: "Dana",
      clientEmail: "dana@example.com",
      businessName: "Soho Vintage Barbers",
    };

    await notifier.notifyClientCreated(input);
    await notifier.notifyClientCreated(input);

    const rows = await EmailOutboxModel.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("PENDING");
    expect(rows[0]?.templateKey).toBe("CLIENT_CREATED");
    expect(rows[0]?.dedupeKey).toBe(`CLIENT_CREATED:${clientId}::CLIENT_CREATED::dana@example.com`);
  });

  it("22/23/24 customer booking: 2 queued PENDING rows, deterministic keys, retry-safe", async () => {
    const business = buildBusiness();
    const booking = buildBooking({ businessId: business._id });
    const notifier = new BookingCreatedNotifier(outboxService, {
      findManyByIds: async () => [
        { _id: business.ownerUserId, normalizedEmail: "owner@example.com" },
      ],
      findProfilesByUserIds: async () => [],
    });

    await notifier.notifyBookingCreated(booking, business);
    await notifier.notifyBookingCreated(booking, business); // simulated retry

    const rows = await EmailOutboxModel.find({}).sort({ templateKey: 1 }).lean();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "PENDING")).toBe(true);
    expect(rows.every((r) => r.eventKey === `BOOKING_CREATED:${String(booking._id)}`)).toBe(true);
    expect(rows.map((r) => r.templateKey).sort()).toEqual([
      "BOOKING_CUSTOMER_CONFIRMED",
      "BOOKING_OWNER_NEW_BOOKING",
    ]);
    expect(rows.map((r) => r.recipient).sort()).toEqual(["dana@example.com", "owner@example.com"]);
  });

  it("supervisor booking queues 3 distinct rows and stays retry-safe", async () => {
    const business = buildBusiness();
    const supervisorUserId = new Types.ObjectId();
    const booking = buildBooking({
      businessId: business._id,
      source: "MANUAL",
      createdBy: { actorUserId: supervisorUserId, actorRole: "SUPERVISOR" },
    });
    const notifier = new BookingCreatedNotifier(outboxService, {
      findManyByIds: async () => [
        { _id: business.ownerUserId, normalizedEmail: "owner@example.com" },
        { _id: supervisorUserId, normalizedEmail: "super@example.com" },
      ],
      findProfilesByUserIds: async () => [
        { userId: supervisorUserId, firstName: "Val", lastName: "Sup" },
      ],
    });

    await notifier.notifyBookingCreated(booking, business);
    await notifier.notifyBookingCreated(booking, business);

    const rows = await EmailOutboxModel.find({}).lean();
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.templateKey === "BOOKING_STAFF_CREATED_NOTIFICATION")).toHaveLength(
      2,
    );
  });
});
