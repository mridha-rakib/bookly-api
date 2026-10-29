import { isDeepStrictEqual } from "node:util";
import type { Types } from "mongoose";
import { AppError } from "../../common/errors/app-error.js";
import { BusinessClientModel } from "../client/client.model.js";
import { PaymentAttemptModel } from "../payment/payment-attempt.model.js";
import { assertPaymentBatchBinding } from "../payment/payment-batch-binding.js";
import {
  BookingCreationClaimModel,
  type PackageBatchScope,
} from "./booking-creation-claim.model.js";
import { verifyPackageBatchActivation } from "./package-batch-authority.js";
import { readOwnedPackageBatchCompletion } from "./package-batch-completion.js";
import { canonicalPackageBatch, PackageBatchUnresolvedError } from "./package-batch-contract.js";
import type { PackageBatchFinancialPersistence } from "./package-batch-financial-persistence.js";
import { PackageCheckoutConflictError } from "./package-checkout.errors.js";
import type { PackageCheckoutCustomerAuthority } from "./package-checkout-customer-authority.js";
import { readPackageCheckoutCustomer } from "./package-checkout-customer-authority.js";
import {
  verifyPackagePurchaseConsentCertification,
  verifyPackagePurchaseProductionCompletion,
} from "./package-purchase-authority.js";

export const packagePurchaseOperationKey = (customerId: Types.ObjectId, operationId: string) =>
  `package-consent:${customerId.toHexString()}:${operationId}`;

/** HTTP orchestration only. F2 remains the one charge-first, same-parent transaction writer.
 * P3B pins/ensures BusinessClient before issuance; this adapter never substitutes that identity. */
export class PackagePurchaseService {
  constructor(
    private readonly authority: PackageCheckoutCustomerAuthority,
    private readonly financial: Pick<PackageBatchFinancialPersistence, "complete">,
  ) {}

  private async owned(
    authorization: string | undefined,
    businessId: Types.ObjectId,
    operationId: string,
  ) {
    const customer = await this.authority.authenticate(authorization),
      actor = readPackageCheckoutCustomer(customer);
    const idempotencyKey = packagePurchaseOperationKey(actor.userId, operationId);
    const row = await BookingCreationClaimModel.findOne({
      idempotencyKey,
      businessId,
      actorUserId: actor.userId,
    })
      .read("primary")
      .readConcern("majority")
      .maxTimeMS(2000);
    if (!row) throw new AppError("Package checkout not found", 404);
    const canonical = canonicalPackageBatch(row.toObject());
    const client = await BusinessClientModel.findOne({
      businessId,
      linkedUserId: actor.userId,
      linkState: "LINKED",
      archivedAt: { $exists: false },
    }).maxTimeMS(2000);
    if (
      !client ||
      (row.packageBatchPreparation &&
        !row.packageBatchPreparation.businessClientId.equals(client._id))
    )
      throw new PackageCheckoutConflictError("Original BusinessClient binding is unavailable");
    const scope: PackageBatchScope = {
      customer,
      businessId,
      businessClientId: client._id,
      idempotencyKey,
    };
    return { row, canonical, scope };
  }

  public async complete(
    authorization: string | undefined,
    businessId: Types.ObjectId,
    operationId: string,
  ) {
    await verifyPackageBatchActivation();
    const { scope } = await this.owned(authorization, businessId, operationId);
    // This check must precede F2 preparation, relationship admission and provider access.
    await verifyPackagePurchaseConsentCertification(scope);
    try {
      await this.financial.complete(scope);
    } catch (error) {
      if (!(error instanceof PackageBatchUnresolvedError)) throw error;
      // Pending/unknown provider or commit results use owned durable evidence below. Never
      // issue a second payment or interpret a provider acknowledgement as purchase success.
    }
    return this.status(authorization, businessId, operationId);
  }

  public async status(
    authorization: string | undefined,
    businessId: Types.ObjectId,
    operationId: string,
  ) {
    await verifyPackageBatchActivation();
    const {
      row,
      canonical: { quote: q, retention, accepted },
      scope,
    } = await this.owned(authorization, businessId, operationId);
    const common = {
      operationId,
      quoteId: String(q.quoteId),
      issuedAt: q.issuedAt,
      expiresAt: q.expiresAt,
      termsHash: retention.quote.termsHash,
      disclosureHash: accepted.disclosureHash,
      canStartNewQuote: false as const,
    };
    const completion = await readOwnedPackageBatchCompletion(scope);
    if (completion) {
      await verifyPackagePurchaseConsentCertification(scope);
      // Explicitly fail closed on the current synthetic completion discriminator.
      await verifyPackagePurchaseProductionCompletion(scope, completion);
      return {
        ...common,
        state: "COMPLETE" as const,
        purchaseCompletion: "VERIFIED" as const,
        packageProgressId: String(completion.progress._id),
        bookingIds: completion.bookings.map((b) => String(b._id)),
      };
    }
    const attempt = await PaymentAttemptModel.findOne({
      logicalIdempotencyKey: scope.idempotencyKey,
      customerUserId: row.actorUserId,
      businessId: scope.businessId,
      productKind: "PACKAGE_PURCHASE",
    })
      .select("+clientSecret")
      .read("primary")
      .maxTimeMS(2000);
    if (attempt) {
      // Status can disclose a recoverable 3DS secret. It must retain the same certified
      // original BusinessClient generation fence as completion, not merely a current link.
      await verifyPackagePurchaseConsentCertification(scope);
      const p = row.packageBatchPreparation;
      if (!p) throw new PackageCheckoutConflictError("Payment lacks exact batch preparation");
      const expected = {
        version: 1,
        claimId: String(row._id),
        batchId: String(p.batchId),
        quoteId: String(q.quoteId),
        termsHash: p.termsHash,
        acceptanceId: String(p.acceptanceId),
        packageProgressId: String(p.packageProgressId),
        originBookingId: String(p.originBookingId),
        businessId: String(scope.businessId),
        customerUserId: String(row.actorUserId),
        businessClientId: String(scope.businessClientId),
      };
      if (!isDeepStrictEqual(assertPaymentBatchBinding(attempt), expected))
        throw new PackageCheckoutConflictError("Payment binding changed");
      const refund = attempt.compensationStatus;
      return {
        ...common,
        state: refund !== "NOT_REQUIRED" ? ("COMPENSATION" as const) : ("PAYMENT_PENDING" as const),
        providerStatus: attempt.providerStatus,
        persistenceStatus: attempt.persistenceStatus,
        compensationStatus: refund,
        // Recovery secret is scoped to the actual Customer/quote/batch and never cached in the UI.
        ...(refund === "NOT_REQUIRED" &&
        ["REQUIRES_ACTION", "FAILED"].includes(attempt.providerStatus) &&
        attempt.clientSecret
          ? { clientSecret: attempt.clientSecret }
          : {}),
      };
    }
    return {
      ...common,
      state: row.packageBatchControl ? ("UNRESOLVED" as const) : ("CONSENT_PENDING" as const),
      certification: "UNRESOLVED" as const,
    };
  }
}
