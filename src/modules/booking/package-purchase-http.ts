import type { Request, Response } from "express";
import { Error as MongooseError, mongo, Types } from "mongoose";
import { z } from "zod";
import { AppError } from "../../common/errors/app-error.js";
import { sendSuccess } from "../../common/http/responses.js";
import { BookingSlotReservationRepository } from "../booking-slot-reservation/booking-slot-reservation.repository.js";
import { BookingSlotReservationService } from "../booking-slot-reservation/booking-slot-reservation.service.js";
import { createFinancialRelationshipService } from "../client/financial-relationship.factory.js";
import { CustomerPaymentProfileRepository } from "../payment/customer-payment-profile.repository.js";
import { PaymentService } from "../payment/payment.service.js";
import { PaymentAttemptRepository } from "../payment/payment-attempt.repository.js";
import { RefundOperationRepository } from "../payment/refund-operation.repository.js";
import { StripePaymentGateway } from "../payment/stripe-payment-gateway.js";
import { verifyPackageBatchActivation } from "./package-batch-authority.js";
import { PackageBatchFinancialPersistence } from "./package-batch-financial-persistence.js";
import { PackageBatchPersistence } from "./package-batch-persistence.js";
import { PackageCheckoutConflictError } from "./package-checkout.errors.js";
import { buildPackageConsentServices } from "./package-consent.factory.js";
import { PACKAGE_CONSENT_STRICT_LIFETIME_MS } from "./package-consent-commit-deadline.js";
import { PackagePurchaseService } from "./package-purchase.service.js";

export const purchaseHttpBodySchema = z
  .object({
    businessId: z
      .string()
      .regex(/^[a-fA-F0-9]{24}$/)
      .transform((s) => new Types.ObjectId(s)),
    operationId: z.uuid(),
  })
  .strict();
export function buildPackagePurchaseService() {
  const s = buildPackageConsentServices(PACKAGE_CONSENT_STRICT_LIFETIME_MS);
  const attempts = new PaymentAttemptRepository(),
    refunds = new RefundOperationRepository();
  const payments = new PaymentService(
    new StripePaymentGateway(),
    new CustomerPaymentProfileRepository(),
    s.users,
    attempts,
    refunds,
  );
  return new PackagePurchaseService(
    s.authority,
    new PackageBatchFinancialPersistence(
      new PackageBatchPersistence(
        s.availability,
        new BookingSlotReservationService(new BookingSlotReservationRepository()),
      ),
      createFinancialRelationshipService({
        paymentAttemptRepository: attempts,
        refundOperationRepository: refunds,
      }),
      payments,
    ),
  );
}
export class PackagePurchaseHttpController {
  constructor(private readonly service: PackagePurchaseService) {}
  execute = async (req: Request, res: Response): Promise<void> => {
    await verifyPackageBatchActivation();
    if (req.auth?.role !== "CUSTOMER" || req.auth.status !== "ACTIVE")
      throw new AppError("Customer purchase only", 403);
    z.enum(["purchase", "purchase-status"]).parse(req.params["action"]);
    const body = purchaseHttpBodySchema.parse(req.body);
    z.object({}).strict().parse(req.query);
    try {
      const result =
        req.params["action"] === "purchase-status"
          ? await this.service.status(req.headers.authorization, body.businessId, body.operationId)
          : await this.service.complete(
              req.headers.authorization,
              body.businessId,
              body.operationId,
            );
      sendSuccess(
        res,
        result.state === "COMPLETE" ? 200 : 202,
        result.state === "COMPLETE"
          ? "Package purchase verified"
          : "Package purchase remains unconfirmed",
        result,
      );
    } catch (error) {
      if (error instanceof PackageCheckoutConflictError)
        throw new AppError(
          "Checkout identity or terms changed. Check this operation's status before starting another.",
          409,
        );
      if (error instanceof z.ZodError)
        throw new AppError(
          "Retained purchase evidence is incomplete or conflicting; purchase remains unconfirmed",
          409,
        );
      if (
        error instanceof mongo.MongoError ||
        error instanceof MongooseError.MongooseServerSelectionError
      )
        throw new AppError(
          "Purchase outcome unavailable; retain the original operation identity",
          503,
        );
      throw error;
    }
  };
}
