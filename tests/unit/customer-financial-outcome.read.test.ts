import mongoose, { Types } from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BookingDocument, BookingModel } from "../../src/modules/booking/booking.model.js";
import { CustomerFinancialOutcomeRead } from "../../src/modules/booking/customer-financial-outcome.read.js";
import { PaymentAttemptModel } from "../../src/modules/payment/payment-attempt.model.js";
import { RefundOperationModel } from "../../src/modules/payment/refund-operation.model.js";
import { ExternalRefundModel } from "../../src/modules/provider-reversal/external-refund.model.js";
import { PaymentDisputeModel } from "../../src/modules/provider-reversal/payment-dispute.model.js";

afterEach(() => vi.restoreAllMocks());
describe("F2D bounded snapshot read orchestration", () => {
  function setup() {
    const user = new Types.ObjectId();
    const booking = {
      _id: new Types.ObjectId(),
      businessId: new Types.ObjectId(),
      source: "BOOKLY_MANAGED",
      customer: { customerUserId: user, businessClientId: new Types.ObjectId() },
      financials: { currency: "EUR" },
      serviceLines: [{ serviceSnapshot: { pricingMode: "FIXED" }, pricingInput: {} }],
    } as unknown as BookingDocument;
    const session = {
      withTransaction: vi.fn(async (read: () => Promise<unknown>) => read()),
      endSession: vi.fn(),
    };
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session as never);
    const owned = { session: vi.fn(async () => booking) };
    vi.spyOn(BookingModel, "findOne").mockReturnValue(owned as never);
    const chains = [
      PaymentAttemptModel,
      RefundOperationModel,
      ExternalRefundModel,
      PaymentDisputeModel,
    ].map((model) => {
      const chain = {
        sort: vi.fn(),
        hint: vi.fn(),
        limit: vi.fn(),
        session: vi.fn(),
        lean: vi.fn(async () => []),
      };
      chain.sort.mockReturnValue(chain);
      chain.hint.mockReturnValue(chain);
      chain.limit.mockReturnValue(chain);
      chain.session.mockReturnValue(chain);
      vi.spyOn(model, "find").mockReturnValue(chain as never);
      return chain;
    });
    return { user, booking, session, chains };
  }
  it("requires owned identity, selects21 indexed candidates and uses one read-only snapshot without provider plumbing", async () => {
    const f = setup();
    const read = new CustomerFinancialOutcomeRead();
    const result = await read.forOwnedBooking(String(f.user), f.booking);
    expect(result.financialOutcome).toMatchObject({ payments: { items: [], hasMore: false } });
    expect(BookingModel.findOne).toHaveBeenCalledWith({
      _id: f.booking._id,
      "customer.customerUserId": String(f.user),
    });
    for (const chain of f.chains) {
      expect(chain.limit).toHaveBeenCalledWith(21);
      expect(chain.hint).toHaveBeenCalledWith({ bookingId: 1, createdAt: -1, _id: -1 });
      expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
      expect(chain.session).toHaveBeenCalledWith(f.session);
    }
    expect(f.session.withTransaction).toHaveBeenCalledWith(expect.any(Function), {
      readConcern: { level: "snapshot" },
    });
    expect(f.session.endSession).toHaveBeenCalledOnce();
  });
  it("omits the optional projection on missing indexes/read failure, never substitutes an empty successful read", async () => {
    const f = setup();
    f.chains[0]!.lean.mockRejectedValueOnce(new Error("missing approved index"));
    const result = await new CustomerFinancialOutcomeRead().forOwnedBooking(
      String(f.user),
      f.booking,
    );
    expect(result).toEqual({ booking: f.booking });
    expect(f.session.endSession).toHaveBeenCalledOnce();
  });
  it("rejects a foreign Customer before querying financial records and rechecks ownership within the snapshot", async () => {
    const f = setup();
    const read = new CustomerFinancialOutcomeRead();
    await expect(
      read.forOwnedBooking(String(new Types.ObjectId()), f.booking),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mongoose.startSession).not.toHaveBeenCalled();
    vi.mocked(BookingModel.findOne).mockReturnValue({ session: vi.fn(async () => null) } as never);
    await expect(read.forOwnedBooking(String(f.user), f.booking)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(f.chains[0]!.lean).not.toHaveBeenCalled();
  });
  it("does not aggregate package or MANUAL financial operations into ordinary detail", async () => {
    const f = setup();
    f.booking.serviceLines[0]!.serviceSnapshot.pricingMode = "PACKAGE";
    expect(
      await new CustomerFinancialOutcomeRead().forOwnedBooking(String(f.user), f.booking),
    ).toEqual({ booking: f.booking });
    expect(mongoose.startSession).not.toHaveBeenCalled();
  });
});
