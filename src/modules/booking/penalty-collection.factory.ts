import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import { BusinessRepository } from "../business/business.repository.js";
import { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import { NoShowNotifier } from "../notification/no-show.notifier.js";
import { PenaltySettlementNotifier } from "../notification/penalty-settlement.notifier.js";
import { PackageProgressRepository } from "../package-progress/package-progress.repository.js";
import type { PaymentService } from "../payment/payment.service.js";
import { UserRepository } from "../user/user.repository.js";
import { BookingRepository } from "./booking.repository.js";
import { PenaltyCollectionService } from "./penalty-collection.service.js";

/** P5 composition-root helper (booking route, no-show worker, Stripe webhook route,
 * money-recovery worker) so every entry point settles customer penalties through identical
 * dependencies — including the durable settlement notifications on the existing outbox. */
export const createPenaltyCollectionService = (deps: {
  paymentService: PaymentService;
  financialTransactionService: BookingFinancialTransactionService;
  bookingRepository?: BookingRepository;
  businessRepository?: BusinessRepository;
  packageProgressRepository?: PackageProgressRepository;
  userRepository?: UserRepository;
}): PenaltyCollectionService =>
  new PenaltyCollectionService({
    paymentService: deps.paymentService,
    financialTransactionService: deps.financialTransactionService,
    bookingRepository: deps.bookingRepository ?? new BookingRepository(),
    businessRepository: deps.businessRepository ?? new BusinessRepository(),
    settlementNotifier: new PenaltySettlementNotifier(
      new EmailOutboxService(),
      deps.userRepository ?? new UserRepository(),
    ),
    noShowNotifier: new NoShowNotifier(new EmailOutboxService()),
    packageProgressRepository: deps.packageProgressRepository ?? new PackageProgressRepository(),
  });
