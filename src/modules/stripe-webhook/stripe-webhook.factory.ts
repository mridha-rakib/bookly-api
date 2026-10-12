import { BookingRepository } from "../booking/booking.repository.js";
import { createPenaltyCollectionService } from "../booking/penalty-collection.factory.js";
import { BookingFinancialTransactionRepository } from "../booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import { createFinancialRelationshipService } from "../client/financial-relationship.factory.js";
import { PackageProgressRepository } from "../package-progress/package-progress.repository.js";
import { CustomerPaymentProfileRepository } from "../payment/customer-payment-profile.repository.js";
import { PaymentService } from "../payment/payment.service.js";
import { PaymentAttemptRepository } from "../payment/payment-attempt.repository.js";
import { PaymentTaxAssociationReconciler } from "../payment/payment-tax-association-reconciler.js";
import { RefundOperationRepository } from "../payment/refund-operation.repository.js";
import { StripePaymentGateway } from "../payment/stripe-payment-gateway.js";
import { createProviderReversalService } from "../provider-reversal/provider-reversal.factory.js";
import { UserRepository } from "../user/user.repository.js";
import { StripeWebhookService } from "./stripe-webhook.service.js";
import { StripeWebhookEventRepository } from "./stripe-webhook-event.repository.js";

/** Composition root of the Stripe webhook processor (the webhook route, and the P6 Super Admin
 * replay of a FAILED event — both must process through identical dependencies). */
export const createStripeWebhookService = (): StripeWebhookService => {
  const gateway = new StripePaymentGateway();
  const eventRepository = new StripeWebhookEventRepository();
  const financialTransactionService = new BookingFinancialTransactionService(
    new BookingFinancialTransactionRepository(),
  );
  const bookingRepository = new BookingRepository();
  const paymentAttemptRepository = new PaymentAttemptRepository();
  const refundOperationRepository = new RefundOperationRepository();
  const packageProgressRepository = new PackageProgressRepository();
  const paymentService = new PaymentService(
    gateway,
    new CustomerPaymentProfileRepository(),
    new UserRepository(),
    paymentAttemptRepository,
    refundOperationRepository,
  );
  return new StripeWebhookService(
    gateway,
    eventRepository,
    financialTransactionService,
    new PaymentTaxAssociationReconciler(gateway, bookingRepository),
    paymentAttemptRepository,
    refundOperationRepository,
    packageProgressRepository,
    bookingRepository,
    createFinancialRelationshipService({
      paymentAttemptRepository,
      refundOperationRepository,
      bookingRepository,
    }),
    createPenaltyCollectionService({
      paymentService,
      financialTransactionService,
      bookingRepository,
      packageProgressRepository,
    }),
    createProviderReversalService({
      gateway,
      financialTransactionService,
      paymentAttemptRepository,
      refundOperationRepository,
      bookingRepository,
    }),
  );
};
