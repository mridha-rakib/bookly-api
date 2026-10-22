import { isDeepStrictEqual } from "node:util";
import type { Types } from "mongoose";

import { BookingError } from "./booking.errors.js";
import {
  type BookingCreationClaimDocument,
  BookingCreationClaimModel,
  commitPackageCheckoutClaimGrant,
} from "./booking-creation-claim.model.js";
import { type FinancialContract, findFinancialContractMismatch } from "./financial-contract.js";
import { PackageCheckoutConflictError } from "./package-checkout.errors.js";
import { assertPackageAccepted, assertPackagePresentation } from "./package-checkout-acceptance.js";
import {
  type PackageCheckoutClaimGrant,
  type PackageCheckoutCustomer,
  readPackageCheckoutCustomer,
} from "./package-checkout-customer-authority.js";
import {
  normalizePackageCheckoutIntent,
  type PackageCheckoutRetention,
  packageCheckoutRetentionSchema,
} from "./package-checkout-retention.js";
import {
  type PackageRequestBinding,
  packageRequestBindingSchema,
} from "./package-request-binding.js";

export type ClaimBookingCreationInput = {
  packageRequestBinding?: PackageRequestBinding | undefined;
  idempotencyKey: string;
  businessId: Types.ObjectId;
  actorUserId: Types.ObjectId;
  bookingId: Types.ObjectId;
};

export type ClaimBookingCreationResult = {
  isNew: boolean;
  bookingId: Types.ObjectId;
};

export class BookingCreationClaimRepository {
  public async findPackageCheckoutForCustomer(
    customerProof: PackageCheckoutCustomer,
    businessId: Types.ObjectId,
    idempotencyKey: string,
  ) {
    const customer = readPackageCheckoutCustomer(customerProof);
    const row = await BookingCreationClaimModel.findOne({
      idempotencyKey,
      businessId,
      actorUserId: customer.userId,
    }).exec();
    if (!row?.packageCheckoutRetention || row.financialContract || row.packageRequestBinding)
      throw new PackageCheckoutConflictError("Owned retained Package checkout required");
    const retention = packageCheckoutRetentionSchema.parse(row.toObject().packageCheckoutRetention);
    if (
      !retention.seed.businessId.equals(businessId) ||
      !retention.seed.customerUserId.equals(customer.userId) ||
      retention.seed.idempotencyKey !== idempotencyKey ||
      !retention.quote.payload.originBookingId.equals(row.bookingId)
    )
      throw new PackageCheckoutConflictError("Checkout claim identity mismatch");
    const presentation = row.packageCheckoutPresentation
      ? assertPackagePresentation(retention, row.toObject().packageCheckoutPresentation)
      : undefined;
    const accepted = row.packageCheckoutAcceptance
      ? assertPackageAccepted(retention, presentation, row.toObject().packageCheckoutAcceptance)
      : undefined;
    return { retention, presentation, accepted };
  }

  public async commitPackageCheckoutGrant(grant: PackageCheckoutClaimGrant): Promise<boolean> {
    return commitPackageCheckoutClaimGrant(grant);
  }

  /** Internal unaccepted checkout read. The unique operation namespace is shared with
   * ordinary creation, so a collision with any other claim kind fails closed. */
  public async findRetainedPackageCheckout(input: {
    idempotencyKey: string;
    businessId: Types.ObjectId;
    actorUserId: Types.ObjectId;
    intent: unknown;
  }): Promise<PackageCheckoutRetention | null> {
    const existing = await BookingCreationClaimModel.findOne({
      idempotencyKey: input.idempotencyKey,
    }).exec();
    if (!existing) return null;
    if (
      !existing.businessId.equals(input.businessId) ||
      !existing.actorUserId.equals(input.actorUserId) ||
      existing.financialContract ||
      existing.packageRequestBinding ||
      !existing.packageCheckoutRetention
    )
      throw new BookingError("BOOKING_IDEMPOTENCY_CONFLICT", 409);
    const retained = packageCheckoutRetentionSchema.parse(
      existing.toObject().packageCheckoutRetention,
    );
    if (
      !isDeepStrictEqual(
        normalizePackageCheckoutIntent(retained.intent),
        normalizePackageCheckoutIntent(input.intent),
      ) ||
      retained.seed.idempotencyKey !== existing.idempotencyKey ||
      !retained.seed.businessId.equals(existing.businessId) ||
      !retained.seed.actorUserId.equals(existing.actorUserId) ||
      !retained.quote.payload.originBookingId.equals(existing.bookingId)
    )
      throw new BookingError("BOOKING_IDEMPOTENCY_CONFLICT", 409);
    return retained;
  }

  /** Insert-only retention. A concurrent winner's entire seed/quote is returned;
   * the losing proposal never changes the operation or financial origin. */
  public async retainPackageCheckout(input: unknown): Promise<PackageCheckoutRetention> {
    const retained = packageCheckoutRetentionSchema.parse(input);
    const scope = {
      idempotencyKey: retained.seed.idempotencyKey,
      businessId: retained.seed.businessId,
      actorUserId: retained.seed.actorUserId,
      intent: retained.intent,
    };
    try {
      await new BookingCreationClaimModel({
        idempotencyKey: scope.idempotencyKey,
        businessId: scope.businessId,
        actorUserId: scope.actorUserId,
        bookingId: retained.quote.payload.originBookingId,
        packageCheckoutRetention: retained,
      }).save();
      return retained;
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) throw error;
      const winner = await this.findRetainedPackageCheckout(scope);
      if (!winner) throw new BookingError("BOOKING_IDEMPOTENCY_CONFLICT", 409);
      return winner;
    }
  }

  /** See booking-creation-claim.model.ts for the full idempotency-contract rationale. */
  public async claim(input: ClaimBookingCreationInput): Promise<ClaimBookingCreationResult> {
    try {
      await new BookingCreationClaimModel(input).save();
      return { isNew: true, bookingId: input.bookingId };
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) {
        throw error;
      }

      const existing = await BookingCreationClaimModel.findOne({
        idempotencyKey: input.idempotencyKey,
      }).orFail();
      if (
        String(existing.businessId) !== String(input.businessId) ||
        String(existing.actorUserId) !== String(input.actorUserId)
      ) {
        throw new BookingError("BOOKING_IDEMPOTENCY_CONFLICT", 409);
      }
      const storedBinding = existing.toObject().packageRequestBinding;
      if (existing.packageCheckoutRetention)
        throw new BookingError("BOOKING_IDEMPOTENCY_CONFLICT", 409);
      if (
        !isDeepStrictEqual(
          storedBinding ? packageRequestBindingSchema.parse(storedBinding) : undefined,
          input.packageRequestBinding
            ? packageRequestBindingSchema.parse(input.packageRequestBinding)
            : undefined,
        )
      ) {
        throw new BookingError("BOOKING_IDEMPOTENCY_CONFLICT", 409);
      }
      return { isNew: false, bookingId: existing.bookingId };
    }
  }

  /** Called only for failures that have no durable provider money operation. Charge-bearing
   * failures retain their claim as part of PaymentAttempt resume/compensation correlation. */
  public async release(idempotencyKey: string): Promise<void> {
    await BookingCreationClaimModel.deleteOne({
      idempotencyKey,
      packageRequestBinding: { $exists: false },
      packageCheckoutRetention: { $exists: false },
    }).exec();
  }

  public async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<BookingCreationClaimDocument | null> {
    return BookingCreationClaimModel.findOne({
      idempotencyKey,
      packageRequestBinding: { $exists: false },
      packageCheckoutRetention: { $exists: false },
    }).exec();
  }

  /** P3-only orchestration will use this explicit bound-claim read; legacy shortcuts cannot. */
  public async findPackageBoundClaim(
    idempotencyKey: string,
    businessId: Types.ObjectId,
    actorUserId: Types.ObjectId,
  ) {
    return BookingCreationClaimModel.findOne({
      idempotencyKey,
      businessId,
      actorUserId,
      packageRequestBinding: { $exists: true },
      packageCheckoutRetention: { $exists: false },
    }).exec();
  }

  /**
   * P1 — records the Financial Contract V2 exactly once (set-if-absent CAS). A later call for the
   * same logical operation must describe identical money terms; any immutable-field difference
   * fails closed with BOOKING_FINANCIAL_CONTRACT_CONFLICT rather than mutating the contract (e.g.
   * a FIRST operation silently becoming RETURNING across a 3DS retry). Also fails closed when
   * the claim itself no longer exists (it was released as a definitive pre-money failure).
   */
  public async recordFinancialContract(
    idempotencyKey: string,
    contract: FinancialContract,
  ): Promise<FinancialContract> {
    if (contract.idempotencyKey !== idempotencyKey) {
      throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
    }
    const recorded = await BookingCreationClaimModel.findOneAndUpdate(
      {
        idempotencyKey,
        bookingId: contract.bookingId,
        financialContract: { $exists: false },
        packageCheckoutRetention: { $exists: false },
      },
      { $set: { financialContract: contract } },
      { returnDocument: "after", runValidators: true },
    ).exec();
    if (recorded?.financialContract) return recorded.financialContract;

    const existing = await BookingCreationClaimModel.findOne({ idempotencyKey }).exec();
    if (
      !existing?.financialContract ||
      existing.packageCheckoutRetention ||
      !existing.bookingId.equals(contract.bookingId)
    ) {
      throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
    }
    if (findFinancialContractMismatch(existing.financialContract, contract)) {
      throw new BookingError("BOOKING_FINANCIAL_CONTRACT_CONFLICT", 409);
    }
    return existing.financialContract;
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}
