import { Types } from "mongoose";
import { afterEach, expect, it, vi } from "vitest";
import { AppError } from "../../src/common/errors/app-error.js";
import type { BookingCreationClaimDocument } from "../../src/modules/booking/booking-creation-claim.model.js";
import * as claims from "../../src/modules/booking/booking-creation-claim.model.js";
import * as batches from "../../src/modules/booking/package-batch-completion.js";
import {
  verifyPackagePurchaseClaimCompletion,
  verifyPackagePurchaseProductionCompletion,
} from "../../src/modules/booking/package-purchase-authority.js";
import { readPackagePurchaseCompletion } from "../../src/modules/package-progress/package-view.service.js";

afterEach(() => vi.restoreAllMocks());
const synthetic = () => ({
  completion: {
    state: "PREPARATION_ONLY_COMPLETE_BATCH",
    activation: "SYNTHETIC_AUTHORITY_NOT_PRODUCTION_CONSENT",
  },
});
it("valid engineering F2 proof cannot become genuine completion, even when the internal verifier succeeds", async () => {
  const read = vi.spyOn(batches, "verifyBatchCompletion").mockResolvedValue(synthetic() as never);
  await expect(
    verifyPackagePurchaseClaimCompletion({} as BookingCreationClaimDocument),
  ).rejects.toMatchObject({
    statusCode: 503,
    details: [
      expect.objectContaining({ code: "PACKAGE_PURCHASE_COMPLETION_AUTHORITY_UNAVAILABLE" }),
    ],
  });
  expect(read).toHaveBeenCalledTimes(1);
});
it("invented genuine marker text cannot substitute for an approved proof schema", async () => {
  vi.spyOn(batches, "verifyBatchCompletion").mockResolvedValue({
    completion: { state: "GENUINE", activation: "CERTIFIED" },
  } as never);
  await expect(
    verifyPackagePurchaseClaimCompletion({} as BookingCreationClaimDocument),
  ).rejects.toMatchObject({ statusCode: 503 });
});
it("public completion rereads and rejects a stale or substituted observation", async () => {
  const row = { toObject: () => ({}) };
  vi.spyOn(claims, "loadOwnedPackageBatch").mockResolvedValue(row as never);
  vi.spyOn(batches, "verifyBatchCompletion").mockResolvedValue(synthetic() as never);
  await expect(
    verifyPackagePurchaseProductionCompletion({} as never, { completion: { state: "other" } }),
  ).rejects.toMatchObject({ statusCode: 409 });
});
it("P2A ownership stays NOT_ESTABLISHED when only internal completion is established", async () => {
  vi.spyOn(claims.BookingCreationClaimModel, "findOne").mockReturnValue({
    read: () => ({ maxTimeMS: () => ({ exec: async () => ({}) }) }),
  } as never);
  vi.spyOn(batches, "verifyBatchCompletion").mockResolvedValue(synthetic() as never);
  const id = new Types.ObjectId();
  expect(await readPackagePurchaseCompletion({ _id: id, businessId: id, customerUserId: id })).toBe(
    "NOT_ESTABLISHED",
  );
});
it("a rejected internal financial/membership proof cannot reach public ownership", async () => {
  vi.spyOn(batches, "verifyBatchCompletion").mockRejectedValue(
    new AppError("inconsistent ledger", 409),
  );
  await expect(verifyPackagePurchaseClaimCompletion({} as never)).rejects.toMatchObject({
    statusCode: 409,
  });
});
