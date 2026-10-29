import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";

import { formatDateTimeWithZone } from "../../src/modules/email/templates/booking/booking-email-data.js";
import type { EmailOutboxService } from "../../src/modules/email-outbox/email-outbox.service.js";
import {
  BookingCreatedNotifier,
  type BookingCreatedPaymentEvidence,
  toOnlinePayment,
} from "../../src/modules/notification/booking-created.notifier.js";
import { buildBooking, buildBusiness } from "./stage-b-fixtures.js";

/**
 * F4A Tier 3 — only agreeing ledger + PaymentAttempt evidence is ever shown as paid, and a
 * payload-build failure inside the Booking transaction aborts instead of writing no rows.
 */

const TZ = "Europe/Nicosia";
const SUCCEEDED_AT = new Date("2026-11-03T07:12:00.000Z");

type Charged = Extract<BookingCreatedPaymentEvidence, { kind: "CHARGED" }>;
type Overrides = {
  ledger?: Partial<NonNullable<Charged["ledger"]>> | null;
  attempt?: Partial<NonNullable<Charged["attempt"]>> | null;
};

const charged = (over: Overrides = {}): BookingCreatedPaymentEvidence =>
  ({
    kind: "CHARGED",
    paymentFor: "BOOKING",
    ledger:
      over.ledger === null
        ? null
        : {
            amountCents: 700,
            currency: "EUR",
            status: "SUCCEEDED",
            direction: "DEBIT",
            providerReference: "pi_synthetic_1",
            ...over.ledger,
          },
    attempt:
      over.attempt === null
        ? null
        : {
            providerStatus: "SUCCEEDED",
            providerPaymentIntentId: "pi_synthetic_1",
            providerSucceededAt: SUCCEEDED_AT,
            expectedAmountCents: 700,
            currency: "EUR",
            ...over.attempt,
          },
  }) as BookingCreatedPaymentEvidence;

describe("toOnlinePayment", () => {
  it("6/11 agreeing evidence → PAID with the ledger amount, provider time and reference", () => {
    expect(toOnlinePayment(charged(), TZ)).toEqual({
      kind: "PAID",
      amountFormatted: "€7.00",
      paidAt: formatDateTimeWithZone(SUCCEEDED_AT, TZ),
      paymentReference: "pi_synthetic_1",
      paymentFor: "BOOKING",
    });
  });

  it("7 no PaymentIntent → NONE; not evaluated → undefined (legacy payload)", () => {
    expect(toOnlinePayment({ kind: "NONE" }, TZ)).toEqual({ kind: "NONE" });
    expect(toOnlinePayment(undefined, TZ)).toBeUndefined();
  });

  it.each([
    ["no ledger row", { ledger: null }],
    ["no attempt", { attempt: null }],
    ["ledger not succeeded", { ledger: { status: "PENDING" } }],
    ["ledger credit, not a charge", { ledger: { direction: "CREDIT" } }],
    ["attempt still processing (8/9)", { attempt: { providerStatus: "PROCESSING" } }],
    ["attempt unknown (9)", { attempt: { providerStatus: "UNKNOWN" } }],
    ["attempt failed (10)", { attempt: { providerStatus: "FAILED" } }],
    ["no provider success time", { attempt: { providerSucceededAt: undefined } }],
    ["reference mismatch", { ledger: { providerReference: "pi_other" } }],
    [
      "missing reference (12)",
      { ledger: { providerReference: undefined }, attempt: { providerPaymentIntentId: undefined } },
    ],
    ["amount mismatch", { attempt: { expectedAmountCents: 800 } }],
    ["currency mismatch", { attempt: { currency: "usd" } }],
  ] as const)("UNVERIFIED when %s — never shown as paid", (_name, over) => {
    expect(toOnlinePayment(charged(over as never), TZ)).toEqual({ kind: "UNVERIFIED" });
  });

  it("accepts the attempt's lowercase currency", () => {
    expect(toOnlinePayment(charged({ attempt: { currency: "eur" } }), TZ)?.kind).toBe("PAID");
  });
});

describe("enqueueBookingCreatedInTransaction with payment evidence", () => {
  const session = { inTransaction: () => true } as unknown as ClientSession;
  const setup = () => {
    const business = buildBusiness();
    const booking = buildBooking({
      businessId: business._id,
      createdBy: { actorUserId: new Types.ObjectId(), actorRole: "CUSTOMER" },
    });
    const enqueue = vi.fn(async () => ({ created: true, record: {} }));
    const notifier = new BookingCreatedNotifier(
      { enqueue } as unknown as Pick<EmailOutboxService, "enqueue">,
      {
        findManyByIds: async () => [
          { _id: business.ownerUserId, normalizedEmail: "o@example.com" },
        ],
        findProfilesByUserIds: async () => [],
      },
    );
    return { business, booking, enqueue, notifier };
  };
  const payloads = (enqueue: ReturnType<typeof setup>["enqueue"]) =>
    enqueue.mock.calls.map(
      (call) => (call as unknown[])[0] as { payload: Record<string, unknown> },
    );

  it("puts verified PAID facts on the customer and owner rows; identity and keys unchanged", async () => {
    const { business, booking, enqueue, notifier } = setup();

    await notifier.enqueueBookingCreatedInTransaction(booking, business, session, charged());

    const rows = payloads(enqueue);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.payload["onlinePayment"]).toMatchObject({
        kind: "PAID",
        amountFormatted: "€7.00",
      });
      expect(row).toMatchObject({ eventKey: `BOOKING_CREATED:${String(booking._id)}` });
    }
  });

  it("2 a payload-build failure now aborts the transaction instead of writing zero rows", async () => {
    const { business, enqueue, notifier } = setup();
    const broken = buildBooking({ serviceLines: undefined as never });

    await expect(
      notifier.enqueueBookingCreatedInTransaction(broken, business, session, { kind: "NONE" }),
    ).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("3 the legitimate business-side skip (lookup failure) still never aborts", async () => {
    const { business, booking, enqueue } = setup();
    const notifier = new BookingCreatedNotifier(
      { enqueue } as unknown as Pick<EmailOutboxService, "enqueue">,
      {
        findManyByIds: async () => {
          throw new Error("db down");
        },
        findProfilesByUserIds: async () => [],
      },
    );

    await notifier.enqueueBookingCreatedInTransaction(booking, business, session, { kind: "NONE" });

    expect(payloads(enqueue)).toHaveLength(1);
  });

  it("the legacy entry point still swallows a build failure (unchanged contract)", async () => {
    const { business, notifier } = setup();
    const broken = buildBooking({ serviceLines: undefined as never });
    await expect(notifier.notifyBookingCreated(broken, business)).resolves.toBeUndefined();
  });
});
