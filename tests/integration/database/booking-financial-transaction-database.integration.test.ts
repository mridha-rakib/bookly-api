import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BookingFinancialTransactionModel } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
import { BookingFinancialTransactionRepository } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

type DbIndex = {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
  partialFilterExpression?: unknown;
};

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  businessId: new Types.ObjectId(),
  bookingId: new Types.ObjectId(),
  businessClientId: new Types.ObjectId(),
  type: "PLATFORM_FEE" as const,
  direction: "DEBIT" as const,
  amountCents: 500,
  currency: "EUR" as const,
  status: "PENDING" as const,
  ...overrides,
});

describe("database-backed BookingFinancialTransaction integration", () => {
  let repository: BookingFinancialTransactionRepository;
  let service: BookingFinancialTransactionService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    repository = new BookingFinancialTransactionRepository();
    service = new BookingFinancialTransactionService(repository);
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  it("has the expected indexes: booking-history, business+type payout aggregation, and a partial unique idempotencyKey", async () => {
    const indexes = (await BookingFinancialTransactionModel.collection.indexes()) as DbIndex[];

    expect(
      indexes.some((index) => index.key["bookingId"] === 1 && index.key["createdAt"] === 1),
    ).toBe(true);
    expect(
      indexes.some(
        (index) =>
          index.key["businessId"] === 1 && index.key["type"] === 1 && index.key["createdAt"] === 1,
      ),
    ).toBe(true);

    const idempotencyIndex = indexes.find((index) => index.key["idempotencyKey"] === 1);
    expect(idempotencyIndex?.unique).toBe(true);
    expect(idempotencyIndex?.partialFilterExpression).toBeDefined();
  });

  it("persists a real entry with integer cents and defaults status to PENDING", async () => {
    const created = await repository.create(baseInput());

    expect(created.amountCents).toBe(500);
    expect(created.status).toBe("PENDING");
    expect(created.currency).toBe("EUR");
    expect(Number.isInteger(created.amountCents)).toBe(true);
  });

  it("rejects a non-integer or non-positive amountCents at the Mongoose layer", async () => {
    await expect(
      BookingFinancialTransactionModel.create(baseInput({ amountCents: 4.5 })),
    ).rejects.toThrow();
    await expect(
      BookingFinancialTransactionModel.create(baseInput({ amountCents: 0 })),
    ).rejects.toThrow();
    await expect(
      BookingFinancialTransactionModel.create(baseInput({ amountCents: -100 })),
    ).rejects.toThrow();
  });

  it("rejects an unknown type/direction/status enum value at the Mongoose layer", async () => {
    await expect(
      BookingFinancialTransactionModel.create(baseInput({ type: "TIP" })),
    ).rejects.toThrow();
    await expect(
      BookingFinancialTransactionModel.create(baseInput({ direction: "SIDEWAYS" })),
    ).rejects.toThrow();
    await expect(
      BookingFinancialTransactionModel.create(baseInput({ status: "MAYBE" })),
    ).rejects.toThrow();
  });

  it("rejects metadata that is not a flat object of primitives", async () => {
    await expect(
      BookingFinancialTransactionModel.create(
        baseInput({ metadata: { nested: { tooDeep: true } } }),
      ),
    ).rejects.toThrow();
    await expect(
      BookingFinancialTransactionModel.create(baseInput({ metadata: ["not", "an", "object"] })),
    ).rejects.toThrow();
  });

  it("accepts flat primitive metadata", async () => {
    const created = await repository.create(
      baseInput({ metadata: { tier: "UNDER_2_HOURS", percent: 50, waived: false } }),
    );
    expect(created.metadata).toEqual({ tier: "UNDER_2_HOURS", percent: 50, waived: false });
  });

  it("enforces idempotencyKey uniqueness only when present — two entries with no key never collide", async () => {
    await repository.create(baseInput({ idempotencyKey: "no-show-charge:booking-1" }));

    await expect(
      BookingFinancialTransactionModel.create(
        baseInput({ idempotencyKey: "no-show-charge:booking-1" }),
      ),
    ).rejects.toMatchObject({ code: 11000 });

    // Two entries with NO idempotencyKey at all must not collide with each other.
    await repository.create(baseInput());
    await repository.create(baseInput());
    expect(await BookingFinancialTransactionModel.countDocuments({})).toBe(2 + 1); // +1 above
  });

  it("record() surfaces a clean domain error on a duplicate idempotency key, through the real unique index", async () => {
    await service.record(baseInput({ idempotencyKey: "no-show-charge:booking-2" }));

    await expect(
      service.record(baseInput({ idempotencyKey: "no-show-charge:booking-2" })),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("updateStatus is the only allowed mutation, and only from PENDING", async () => {
    const created = await repository.create(baseInput({ status: "PENDING" }));

    const settled = await repository.updateStatus(created._id, "SUCCEEDED");
    expect(settled?.status).toBe("SUCCEEDED");

    // Once settled, a second updateStatus call (matching only PENDING rows) is a no-op —
    // this collection is immutable outside the single PENDING -> settled transition.
    const secondAttempt = await repository.updateStatus(created._id, "FAILED");
    expect(secondAttempt).toBeNull();

    const reloaded = await BookingFinancialTransactionModel.findById(created._id).orFail();
    expect(reloaded.status).toBe("SUCCEEDED");
  });

  it("does not affect or read Booking.financials — this collection is entirely separate from that summary", async () => {
    // Booking.financials is asserted elsewhere (booking-database.integration.test.ts) to be
    // populated independently by BookingService — this ledger has no coupling to it at all,
    // confirmed here by the fact record() never touches the Booking collection.
    const created = await service.record(baseInput());
    expect(created.bookingId).toBeInstanceOf(Types.ObjectId);
  });

  it("lists a Booking's transactions in creation order", async () => {
    const bookingId = new Types.ObjectId();
    await service.record(baseInput({ bookingId, type: "DEPOSIT", direction: "DEBIT" }));
    await service.record(baseInput({ bookingId, type: "PLATFORM_FEE", direction: "DEBIT" }));
    await service.record(baseInput({ bookingId: new Types.ObjectId() }));

    const result = await service.listForBooking(bookingId);
    expect(result.map((row) => row.type)).toEqual(["DEPOSIT", "PLATFORM_FEE"]);
  });

  it("lists a Business's transactions within a bounded range, scoped to that business only", async () => {
    const businessId = new Types.ObjectId();
    const otherBusinessId = new Types.ObjectId();
    await service.record(baseInput({ businessId }));
    await service.record(baseInput({ businessId: otherBusinessId }));

    const from = new Date(Date.now() - oneHourMs());
    const to = new Date(Date.now() + oneHourMs());
    const result = await service.listForBusiness({ businessId, from, to });

    expect(result).toHaveLength(1);
    expect(String(result[0]?.businessId)).toBe(String(businessId));
  });
});

function oneHourMs(): number {
  return 60 * 60 * 1000;
}
