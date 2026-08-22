import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";

import type { BookingFinancialTransactionDocument } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
import type {
  BookingFinancialTransactionRepository,
  CreateBookingFinancialTransactionInput,
} from "../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";

const baseInput = (
  overrides: Partial<CreateBookingFinancialTransactionInput> = {},
): CreateBookingFinancialTransactionInput => ({
  businessId: new Types.ObjectId(),
  bookingId: new Types.ObjectId(),
  businessClientId: new Types.ObjectId(),
  type: "PLATFORM_FEE",
  direction: "DEBIT",
  amountCents: 500,
  currency: "EUR",
  status: "PENDING",
  ...overrides,
});

class FakeRepository implements Partial<BookingFinancialTransactionRepository> {
  public rows: BookingFinancialTransactionDocument[] = [];
  public existingIdempotencyKeys = new Set<string>();

  public readonly create = vi.fn(async (input: CreateBookingFinancialTransactionInput) => {
    if (input.idempotencyKey && this.existingIdempotencyKeys.has(input.idempotencyKey)) {
      throw Object.assign(new Error("duplicate key"), { code: 11000 });
    }

    if (input.idempotencyKey) {
      this.existingIdempotencyKeys.add(input.idempotencyKey);
    }

    const now = new Date();
    const document = {
      _id: new Types.ObjectId(),
      ...input,
      createdAt: now,
      updatedAt: now,
    } as BookingFinancialTransactionDocument;
    this.rows.push(document);
    return document;
  });

  public readonly listByBookingId = vi.fn(async (bookingId: Types.ObjectId | string) =>
    this.rows.filter((row) => String(row.bookingId) === String(bookingId)),
  );

  public readonly listByBusinessId = vi.fn(
    async (input: { businessId: Types.ObjectId | string; from: Date; to: Date }) =>
      this.rows.filter(
        (row) =>
          String(row.businessId) === String(input.businessId) &&
          row.createdAt >= input.from &&
          row.createdAt < input.to,
      ),
  );
}

const createService = () => {
  const repository = new FakeRepository();
  const service = new BookingFinancialTransactionService(
    repository as unknown as BookingFinancialTransactionRepository,
  );
  return { repository, service };
};

describe("BookingFinancialTransactionService", () => {
  it("records a well-formed DEBIT charge", async () => {
    const { service } = createService();

    const result = await service.record(baseInput());

    expect(result.amountCents).toBe(500);
    expect(result.status).toBe("PENDING");
  });

  it.each([
    ["DEPOSIT", "DEBIT"],
    ["PAYMENT", "DEBIT"],
    ["PLATFORM_FEE", "DEBIT"],
    ["CANCELLATION_FEE", "DEBIT"],
    ["NO_SHOW_FEE", "DEBIT"],
    ["REFUND", "CREDIT"],
    ["BUSINESS_PAYOUT", "CREDIT"],
  ] as const)("rejects %s recorded with the wrong direction", async (type, requiredDirection) => {
    const { service } = createService();
    const wrongDirection = requiredDirection === "DEBIT" ? "CREDIT" : "DEBIT";

    await expect(
      service.record(baseInput({ type, direction: wrongDirection })),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("allows ADJUSTMENT in either direction — the one type without a fixed direction", async () => {
    const { service } = createService();

    await expect(
      service.record(baseInput({ type: "ADJUSTMENT", direction: "DEBIT" })),
    ).resolves.toBeDefined();
    await expect(
      service.record(baseInput({ type: "ADJUSTMENT", direction: "CREDIT" })),
    ).resolves.toBeDefined();
  });

  it("surfaces a clear domain error on a duplicate idempotency key rather than a raw Mongo error", async () => {
    const { service } = createService();
    await service.record(baseInput({ idempotencyKey: "no-show-charge:booking-1" }));

    await expect(
      service.record(baseInput({ idempotencyKey: "no-show-charge:booking-1" })),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("lists a Booking's transactions", async () => {
    const { service } = createService();
    const bookingId = new Types.ObjectId();
    await service.record(baseInput({ bookingId }));
    await service.record(baseInput({ bookingId, type: "DEPOSIT" }));
    await service.record(baseInput());

    const result = await service.listForBooking(bookingId);
    expect(result).toHaveLength(2);
  });

  it("rejects a business-ledger list request with from >= to", async () => {
    const { service } = createService();
    const businessId = new Types.ObjectId();
    const now = new Date("2026-06-01T00:00:00.000Z");

    await expect(service.listForBusiness({ businessId, from: now, to: now })).rejects.toMatchObject(
      { statusCode: 400 },
    );
  });

  it("rejects a business-ledger list request wider than the maximum range", async () => {
    const { service } = createService();
    const businessId = new Types.ObjectId();
    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date("2026-12-31T00:00:00.000Z");

    await expect(service.listForBusiness({ businessId, from, to })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("accepts a business-ledger list request within the maximum range", async () => {
    const { service } = createService();
    const businessId = new Types.ObjectId();
    const from = new Date("2026-06-01T00:00:00.000Z");
    const to = new Date("2026-06-30T00:00:00.000Z");

    await expect(service.listForBusiness({ businessId, from, to })).resolves.toEqual([]);
  });
});
