import type { Types } from "mongoose";

import type { BookingRepository } from "../booking/booking.repository.js";
import type { CustomerPaymentProfileRepository } from "./customer-payment-profile.repository.js";
import { PaymentError } from "./payment.errors.js";
import type { PaymentGateway } from "./payment.types.js";
import type { PaymentAttemptRepository } from "./payment-attempt.repository.js";

export type SavedCardRemovalResult = {
  removed: true;
  paymentMethodId: string;
  /** The provider already had nothing attached (a retry, or a card removed elsewhere). */
  alreadyDetached: boolean;
};

export type SavedCardBlockReason = "ACTIVE_PAYMENT" | "ACTIVE_BOOKING";

/**
 * P2.2.5 — Customer saved-card removal. Stripe is the authority for the PaymentMethod; the
 * CustomerPaymentProfile is Bookly's single-card projection (the card every payment and
 * off-session fee reads). Order of operations:
 *
 * 1. Ownership: the PaymentMethod must be attached to the session Customer's own Stripe
 *    Customer (read from Stripe), or be that Customer's stale local card. Anything else is the
 *    same 404, so other Customers' cards are never revealed.
 * 2. Safety: refused (409) while an unsettled payment (not sent / sent / awaiting 3DS /
 *    processing / unknown) or an UPCOMING/PENDING booking (whose late-cancellation / no-show
 *    fee is charged off-session to this card) exists.
 * 3. The local card is cleared first (CAS on this exact card) so no new payment can select it,
 *    then safety is re-checked to close the race with a payment/booking started meanwhile; if
 *    one appeared, the card is restored and the removal refused.
 * 4. Stripe detach. A definite rejection restores the local card; an uncertain result is
 *    re-read from Stripe, and if still unknown the card stays unselectable and the Customer is
 *    told to retry (a retry is idempotent: it detaches or confirms it is gone).
 *
 * No Booking, PaymentIntent, ledger row, refund or receipt is read for change or modified.
 */
export class SavedCardRemovalService {
  public constructor(
    private readonly gateway: PaymentGateway,
    private readonly profileRepository: Pick<
      CustomerPaymentProfileRepository,
      "findByUserId" | "clearPaymentMethodIfCurrent" | "restorePaymentMethodIfEmpty"
    >,
    private readonly paymentAttemptRepository: Pick<
      PaymentAttemptRepository,
      "hasUnsettledForCustomer"
    >,
    private readonly bookingRepository: Pick<BookingRepository, "hasActiveForCustomer">,
  ) {}

  public async removeSavedCard(
    userId: Types.ObjectId | string,
    paymentMethodId: string,
  ): Promise<SavedCardRemovalResult> {
    const gateway = this.gateway;
    if (!gateway.lookupPaymentMethodOwner || !gateway.detachPaymentMethod) {
      throw new PaymentError("PAYMENT_PROVIDER_NOT_CONFIGURED", 503);
    }

    const profile = await this.profileRepository.findByUserId(userId);
    if (!profile) throw new PaymentError("PAYMENT_METHOD_NOT_FOUND", 404);
    const isLocalCard = profile.defaultPaymentMethodId === paymentMethodId;

    // 1. Ownership, from Stripe.
    const owner = await gateway.lookupPaymentMethodOwner(paymentMethodId);
    if (owner.outcome === "UNCERTAIN") throw new PaymentError("PAYMENT_METHOD_REMOVAL_FAILED", 503);
    const attachedToCustomer =
      owner.outcome === "FOUND" && owner.customerId === profile.stripeCustomerId;
    const goneAtProvider =
      owner.outcome === "NOT_FOUND" || (owner.outcome === "FOUND" && owner.customerId === null);

    if (!attachedToCustomer) {
      if (goneAtProvider && isLocalCard) {
        // Stripe no longer has it attached: only Bookly's stale reference remains.
        await this.profileRepository.clearPaymentMethodIfCurrent(userId, paymentMethodId);
        return { removed: true, paymentMethodId, alreadyDetached: true };
      }
      throw new PaymentError("PAYMENT_METHOD_NOT_FOUND", 404);
    }
    if (owner.outcome === "FOUND" && !owner.isCard) {
      throw new PaymentError("PAYMENT_METHOD_NOT_FOUND", 404);
    }

    // 2. Safety.
    await this.requireNoActiveObligation(userId);

    // 3. Stop new payments from selecting it, then re-check for anything started meanwhile.
    const previous = isLocalCard
      ? await this.profileRepository.clearPaymentMethodIfCurrent(userId, paymentMethodId)
      : null;
    const lateBlock = await this.activeObligation(userId);
    if (lateBlock) {
      if (previous) await this.profileRepository.restorePaymentMethodIfEmpty(userId, previous);
      throw this.inUse(lateBlock);
    }

    // 4. Detach at Stripe.
    const { outcome } = await gateway.detachPaymentMethod(paymentMethodId);
    if (outcome === "DETACHED") return { removed: true, paymentMethodId, alreadyDetached: false };
    if (outcome === "NOT_FOUND" || outcome === "NOT_ATTACHED") {
      return { removed: true, paymentMethodId, alreadyDetached: true };
    }
    if (outcome === "REJECTED") {
      if (previous) await this.profileRepository.restorePaymentMethodIfEmpty(userId, previous);
      throw new PaymentError("PAYMENT_METHOD_REMOVAL_FAILED", 502);
    }

    // UNCERTAIN: re-read the authoritative state instead of guessing.
    const recheck = await gateway.lookupPaymentMethodOwner(paymentMethodId);
    if (
      recheck.outcome === "NOT_FOUND" ||
      (recheck.outcome === "FOUND" && recheck.customerId === null)
    ) {
      return { removed: true, paymentMethodId, alreadyDetached: false };
    }
    // Still attached or unknown: it stays unusable in Bookly; a retry finishes the removal.
    throw new PaymentError("PAYMENT_METHOD_REMOVAL_UNCONFIRMED", 503);
  }

  private async activeObligation(
    userId: Types.ObjectId | string,
  ): Promise<SavedCardBlockReason | null> {
    const [unsettledPayment, activeBooking] = await Promise.all([
      this.paymentAttemptRepository.hasUnsettledForCustomer(userId),
      this.bookingRepository.hasActiveForCustomer(userId),
    ]);
    if (unsettledPayment) return "ACTIVE_PAYMENT";
    if (activeBooking) return "ACTIVE_BOOKING";
    return null;
  }

  private async requireNoActiveObligation(userId: Types.ObjectId | string): Promise<void> {
    const reason = await this.activeObligation(userId);
    if (reason) throw this.inUse(reason);
  }

  private inUse(reason: SavedCardBlockReason): PaymentError {
    const message =
      reason === "ACTIVE_PAYMENT"
        ? "A payment using this card is still in progress or awaiting authentication. Finish or wait for it, then try again."
        : "You have an upcoming booking secured by this card (late-cancellation and no-show terms). Remove the card after it is completed or cancelled.";
    return new PaymentError("PAYMENT_METHOD_IN_USE", 409, [{ message, code: reason }]);
  }
}
