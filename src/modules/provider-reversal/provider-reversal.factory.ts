import { BookingRepository } from "../booking/booking.repository.js";
import { BookingFinancialTransactionRepository } from "../booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import { BusinessRepository } from "../business/business.repository.js";
import { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import { ProviderReversalNotifier } from "../notification/provider-reversal.notifier.js";
import type { PaymentGateway } from "../payment/payment.types.js";
import { PaymentAttemptRepository } from "../payment/payment-attempt.repository.js";
import { RefundOperationRepository } from "../payment/refund-operation.repository.js";
import { StripePaymentGateway } from "../payment/stripe-payment-gateway.js";
import { UserRepository } from "../user/user.repository.js";
import { ProviderReversalQueryService } from "./provider-reversal.query.js";
import {
  ExternalRefundRepository,
  PaymentDisputeRepository,
} from "./provider-reversal.repository.js";
import { ProviderReversalService } from "./provider-reversal.service.js";

/** P6 composition-root helper (Stripe webhook route, money-recovery worker, Super Admin routes)
 * so every entry point reconciles provider reversals through identical dependencies — including
 * the support / Business notifications on the existing outbox. */
export const createProviderReversalService = (
  deps: {
    gateway?: PaymentGateway;
    financialTransactionService?: BookingFinancialTransactionService;
    paymentAttemptRepository?: PaymentAttemptRepository;
    refundOperationRepository?: RefundOperationRepository;
    bookingRepository?: BookingRepository;
    businessRepository?: BusinessRepository;
    userRepository?: UserRepository;
  } = {},
): ProviderReversalService =>
  new ProviderReversalService({
    gateway: deps.gateway ?? new StripePaymentGateway(),
    disputes: new PaymentDisputeRepository(),
    externalRefunds: new ExternalRefundRepository(),
    financialTransactionService:
      deps.financialTransactionService ??
      new BookingFinancialTransactionService(new BookingFinancialTransactionRepository()),
    paymentAttemptRepository: deps.paymentAttemptRepository ?? new PaymentAttemptRepository(),
    refundOperationRepository: deps.refundOperationRepository ?? new RefundOperationRepository(),
    bookingRepository: deps.bookingRepository ?? new BookingRepository(),
    businessRepository: deps.businessRepository ?? new BusinessRepository(),
    notifier: new ProviderReversalNotifier(
      new EmailOutboxService(),
      deps.userRepository ?? new UserRepository(),
    ),
  });

export const createProviderReversalQueryService = (
  financialTransactionService: BookingFinancialTransactionService = new BookingFinancialTransactionService(
    new BookingFinancialTransactionRepository(),
  ),
): ProviderReversalQueryService =>
  new ProviderReversalQueryService(
    new PaymentDisputeRepository(),
    new ExternalRefundRepository(),
    financialTransactionService,
  );
