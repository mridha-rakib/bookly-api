import { BookingRepository } from "../booking/booking.repository.js";
import { BookingCreationClaimRepository } from "../booking/booking-creation-claim.repository.js";
import { PaymentAttemptRepository } from "../payment/payment-attempt.repository.js";
import { RefundOperationRepository } from "../payment/refund-operation.repository.js";
import { ClientRepository } from "./client.repository.js";
import { FinancialRelationshipRepository } from "./financial-relationship.repository.js";
import { FinancialRelationshipService } from "./financial-relationship.service.js";

/** Composition-root helper (booking route, Stripe webhook route, money-recovery worker) so every
 * entry point drives the one customer↔business relationship through identical dependencies. */
export const createFinancialRelationshipService = (
  overrides: {
    paymentAttemptRepository?: PaymentAttemptRepository;
    refundOperationRepository?: RefundOperationRepository;
    bookingRepository?: BookingRepository;
    claimRepository?: BookingCreationClaimRepository;
    clientRepository?: ClientRepository;
  } = {},
): FinancialRelationshipService =>
  new FinancialRelationshipService(
    new FinancialRelationshipRepository(),
    overrides.paymentAttemptRepository ?? new PaymentAttemptRepository(),
    overrides.refundOperationRepository ?? new RefundOperationRepository(),
    overrides.bookingRepository ?? new BookingRepository(),
    overrides.claimRepository ?? new BookingCreationClaimRepository(),
    overrides.clientRepository ?? new ClientRepository(),
  );
