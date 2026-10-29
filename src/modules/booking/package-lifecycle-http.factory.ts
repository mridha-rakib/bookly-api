import { AddonRepository } from "../addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../addons/addon-service-assignment.repository.js";
import { TokenService } from "../auth/token.service.js";
import { AvailabilityService } from "../availability/availability.service.js";
import { BookingSlotReservationRepository } from "../booking-slot-reservation/booking-slot-reservation.repository.js";
import { BookingSlotReservationService } from "../booking-slot-reservation/booking-slot-reservation.service.js";
import { BusinessRepository } from "../business/business.repository.js";
import { BusinessBookingSettingsRepository } from "../business-booking-settings/business-booking-settings.repository.js";
import { BusinessHoursRepository } from "../business-hours/business-hours.repository.js";
import { BusinessTravelSettingsRepository } from "../business-travel-settings/business-travel-settings.repository.js";
import { ClientRepository } from "../client/client.repository.js";
import { CustomerPaymentProfileRepository } from "../payment/customer-payment-profile.repository.js";
import { PaymentService } from "../payment/payment.service.js";
import { PaymentAttemptRepository } from "../payment/payment-attempt.repository.js";
import { RefundOperationRepository } from "../payment/refund-operation.repository.js";
import { StripePaymentGateway } from "../payment/stripe-payment-gateway.js";
import { ServiceRepository } from "../services/service.repository.js";
import { SessionRepository } from "../session/session.repository.js";
import { StaffRepository } from "../staff/staff.repository.js";
import { StaffScheduleRepository } from "../staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../staff/staff-time-off.repository.js";
import { UserRepository } from "../user/user.repository.js";
import { BookingRepository } from "./booking.repository.js";
import { BookingService } from "./booking.service.js";
import { PackageCheckoutCustomerAuthority } from "./package-checkout-customer-authority.js";
import { PackageLifecycleService } from "./package-lifecycle.service.js";
import { PackageLifecycleOperations } from "./package-lifecycle-operation.js";

/** Lazy composition: only reached after production activation authority succeeds. */
export function buildPackageLifecycleHttpServices() {
  const businesses = new BusinessRepository(),
    staff = new StaffRepository(),
    services = new ServiceRepository(),
    users = new UserRepository();
  const tokens = new TokenService(new SessionRepository());
  const reservations = new BookingSlotReservationRepository();
  const availability = new AvailabilityService(
    businesses,
    services,
    staff,
    new StaffScheduleRepository(),
    new StaffTimeOffRepository(),
    new BusinessHoursRepository(),
    new BusinessBookingSettingsRepository(),
    new BusinessTravelSettingsRepository(),
    reservations,
  );
  const management = new BookingService(
    businesses,
    staff,
    services,
    new AddonRepository(),
    new AddonServiceAssignmentRepository(),
    new ClientRepository(),
    new BookingRepository(),
  );
  const payments = new PaymentService(
    new StripePaymentGateway(),
    new CustomerPaymentProfileRepository(),
    users,
    new PaymentAttemptRepository(),
    new RefundOperationRepository(),
  );
  return {
    tokens,
    users,
    staff,
    availability,
    authority: new PackageCheckoutCustomerAuthority(tokens, users),
    management,
    operations: new PackageLifecycleOperations(),
    lifecycle: new PackageLifecycleService(
      availability,
      new BookingSlotReservationService(reservations),
      management,
      undefined,
      payments,
    ),
  };
}
export type PackageLifecycleHttpServices = ReturnType<typeof buildPackageLifecycleHttpServices>;
