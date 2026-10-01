import { describe, expect, it } from "vitest";

import { BookingModel } from "../../src/modules/booking/booking.model.js";
import {
  taxLiabilityIdempotencyKey,
  taxReversalIdempotencyKey,
} from "../../src/modules/booking-financial-transaction/tax-ledger-idempotency.js";

describe("tax ledger and booking snapshot foundation", () => {
  it("keeps every VAT snapshot path optional with no historical default", () => {
    for (const path of [
      "financials.preTaxChargeCents",
      "financials.taxCents",
      "financials.chargedAmountCents",
      "financials.taxCalculationId",
      "financials.paymentIntentId",
      "financials.taxTransactionId",
    ]) {
      const schemaPath = BookingModel.schema.path(path);
      expect(schemaPath).toBeDefined();
      expect(schemaPath?.options["required"]).not.toBe(true);
      expect(schemaPath?.options["default"]).toBeUndefined();
    }
  });

  it("provides deterministic tax posting and reversal keys", () => {
    expect(taxLiabilityIdempotencyKey("pi_123")).toBe("tax-liability:pi_123");
    expect(taxReversalIdempotencyKey("re_123")).toBe("tax-reversal:re_123");
    expect(taxLiabilityIdempotencyKey("pi_123")).not.toBe(taxReversalIdempotencyKey("re_123"));
  });
});
