import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { EmailOutboxModel } from "../../../src/modules/email-outbox/email-outbox.model.js";
import { EmailOutboxRepository } from "../../../src/modules/email-outbox/email-outbox.repository.js";
import { EmailOutboxService } from "../../../src/modules/email-outbox/email-outbox.service.js";
import { BookingCompletedNotifier } from "../../../src/modules/notification/booking-completed.notifier.js";
import { buildBusiness, buildCompletedBooking } from "../../unit/stage-c-fixtures.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/**
 * MAILING STAGE C — BOOKING_COMPLETED goes through the real Stage-A EmailOutbox: exactly one
 * PENDING customer row, deterministic key, retry-safe. Part AE items 3, 5, and async delivery.
 */
describe("Stage C BOOKING_COMPLETED → EmailOutbox integration", () => {
  let notifier: BookingCompletedNotifier;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    notifier = new BookingCompletedNotifier(new EmailOutboxService(new EmailOutboxRepository()));
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  it("3/5 a retried completion enqueues exactly one PENDING BOOKING_COMPLETED row", async () => {
    const business = buildBusiness();
    const booking = buildCompletedBooking({ businessId: business._id });

    await notifier.notifyBookingCompleted(booking, business);
    await notifier.notifyBookingCompleted(booking, business); // idempotent replay

    const rows = await EmailOutboxModel.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("PENDING");
    expect(rows[0]?.templateKey).toBe("BOOKING_COMPLETED");
    expect(rows[0]?.recipient).toBe("dana@example.com");
    expect(rows[0]?.eventKey).toBe(`BOOKING_COMPLETED:${String(booking._id)}`);
    expect(rows[0]?.dedupeKey).toBe(
      `BOOKING_COMPLETED:${String(booking._id)}::BOOKING_COMPLETED::dana@example.com`,
    );
    // payload carries the full InvoiceData for the worker to render body + PDF from
    const payload = rows[0]?.payload as { invoice?: { financial?: { settlementStatus?: string } } };
    expect(payload.invoice?.financial?.settlementStatus).toBe("FULL");
  });
});
