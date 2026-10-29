import { AddonRepository } from "../addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../addons/addon-service-assignment.repository.js";
import { TokenService } from "../auth/token.service.js";
import { AvailabilityService } from "../availability/availability.service.js";
import { BookingSlotReservationRepository } from "../booking-slot-reservation/booking-slot-reservation.repository.js";
import { BusinessRepository } from "../business/business.repository.js";
import { BusinessBookingSettingsRepository } from "../business-booking-settings/business-booking-settings.repository.js";
import { BusinessCancellationPolicyRepository } from "../business-cancellation-policy/business-cancellation-policy.repository.js";
import { BusinessHoursRepository } from "../business-hours/business-hours.repository.js";
import { BusinessTravelSettingsRepository } from "../business-travel-settings/business-travel-settings.repository.js";
import { ClientRepository } from "../client/client.repository.js";
import { createFinancialRelationshipService } from "../client/financial-relationship.factory.js";
import { PackageRepository } from "../packages/package.repository.js";
import { CustomerPaymentProfileRepository } from "../payment/customer-payment-profile.repository.js";
import { PaymentAttemptRepository } from "../payment/payment-attempt.repository.js";
import { RefundOperationRepository } from "../payment/refund-operation.repository.js";
import { ServiceRepository } from "../services/service.repository.js";
import { SessionRepository } from "../session/session.repository.js";
import { StaffRepository } from "../staff/staff.repository.js";
import { StaffScheduleRepository } from "../staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../staff/staff-time-off.repository.js";
import { UserRepository } from "../user/user.repository.js";
import { BookingRepository } from "./booking.repository.js";
import { BookingService } from "./booking.service.js";
import { BookingCreationClaimRepository } from "./booking-creation-claim.repository.js";
import { PackageCheckoutAcceptanceService } from "./package-checkout-acceptance.service.js";
import { PackageCheckoutCustomerAuthority } from "./package-checkout-customer-authority.js";
import {
  PackageCheckoutQuotePreparer,
  readPackageCheckoutNoShowWindows,
} from "./package-checkout-quote.service.js";
import { PackageCheckoutRetentionService } from "./package-checkout-retention.service.js";
import { PackageConsentProtocol } from "./package-consent-protocol.js";

/** Read-only quote dependencies and canonical claim writes. No provider client or activation service. */
export const buildPackageConsentServices = (lifetimeMs: number) => {
  const businesses = new BusinessRepository(),
    packages = new PackageRepository(),
    services = new ServiceRepository();
  const staff = new StaffRepository(),
    users = new UserRepository(),
    clients = new ClientRepository();
  const bookings = new BookingRepository(),
    claims = new BookingCreationClaimRepository();
  const travel = new BusinessTravelSettingsRepository(),
    profiles = new CustomerPaymentProfileRepository();
  const tokens = new TokenService(new SessionRepository());
  const authority = new PackageCheckoutCustomerAuthority(tokens, users);
  const availability = new AvailabilityService(
    businesses,
    services,
    staff,
    new StaffScheduleRepository(),
    new StaffTimeOffRepository(),
    new BusinessHoursRepository(),
    new BusinessBookingSettingsRepository(),
    travel,
    new BookingSlotReservationRepository(),
  );
  const booking = new BookingService(
    businesses,
    staff,
    services,
    new AddonRepository(),
    new AddonServiceAssignmentRepository(),
    clients,
    bookings,
  );
  const relationships = createFinancialRelationshipService({
    clientRepository: clients,
    bookingRepository: bookings,
    claimRepository: claims,
    paymentAttemptRepository: new PaymentAttemptRepository(),
    refundOperationRepository: new RefundOperationRepository(),
  });
  const preparer = new PackageCheckoutQuotePreparer({
    businesses,
    packages,
    services,
    staff,
    clients,
    relationships,
    booking,
    availability,
    travel,
    policies: new BusinessCancellationPolicyRepository(),
    readNoShowWindows: readPackageCheckoutNoShowWindows,
    cards: {
      getSavedCardStatus: async (id) => ({
        hasSavedCard: Boolean((await profiles.findByUserId(id))?.defaultPaymentMethodId),
      }),
    },
  });
  const consent = new PackageConsentProtocol();
  return {
    tokens,
    users,
    authority,
    claims,
    businesses,
    packages,
    services,
    staff,
    availability,
    retention: new PackageCheckoutRetentionService(
      claims,
      packages,
      preparer,
      lifetimeMs,
      undefined,
      consent,
    ),
    acceptance: new PackageCheckoutAcceptanceService(
      claims,
      authority,
      preparer,
      staff,
      users,
      undefined,
      consent,
    ),
  };
};
