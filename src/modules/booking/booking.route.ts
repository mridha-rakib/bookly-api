import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { AddonRepository } from "../addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../addons/addon-service-assignment.repository.js";
import { AppointmentReminderRepository } from "../appointment-reminder/appointment-reminder.repository.js";
import { AppointmentReminderScheduler } from "../appointment-reminder/appointment-reminder-scheduler.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireApprovedBusiness,
  requireRoles,
} from "../auth/auth.middleware.js";
import { TokenService } from "../auth/token.service.js";
import { AvailabilityService } from "../availability/availability.service.js";
import { BookingFinancialTransactionRepository } from "../booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import { BookingSlotReservationRepository } from "../booking-slot-reservation/booking-slot-reservation.repository.js";
import { BookingSlotReservationService } from "../booking-slot-reservation/booking-slot-reservation.service.js";
import { BusinessRepository } from "../business/business.repository.js";
import { BusinessBookingSettingsRepository } from "../business-booking-settings/business-booking-settings.repository.js";
import { BusinessCancellationPolicyRepository } from "../business-cancellation-policy/business-cancellation-policy.repository.js";
import { BusinessHoursRepository } from "../business-hours/business-hours.repository.js";
import { BusinessMediaRepository } from "../business-media/business-media.repository.js";
import { BusinessTravelSettingsRepository } from "../business-travel-settings/business-travel-settings.repository.js";
import { ClientRepository } from "../client/client.repository.js";
import { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import { IntegrationRepository } from "../integration/integration.repository.js";
import { IntegrationService } from "../integration/integration.service.js";
import { BookingCancelledNotifier } from "../notification/booking-cancelled.notifier.js";
import { BookingCompletedNotifier } from "../notification/booking-completed.notifier.js";
import { BookingCreatedNotifier } from "../notification/booking-created.notifier.js";
import { BookingRescheduledCustomerNotifier } from "../notification/booking-rescheduled-customer.notifier.js";
import { NoShowNotifier } from "../notification/no-show.notifier.js";
import { StaffBookingNotifier } from "../notification/staff-booking.notifier.js";
import { CustomerPaymentProfileRepository } from "../payment/customer-payment-profile.repository.js";
import { PaymentService } from "../payment/payment.service.js";
import { StripePaymentGateway } from "../payment/stripe-payment-gateway.js";
import { PlatformSettingsRepository } from "../platform-settings/platform-settings.repository.js";
import { PlatformSettingsService } from "../platform-settings/platform-settings.service.js";
import { PromoRepository } from "../promo/promo.repository.js";
import { PromoApplicationService } from "../promo/promo-application.service.js";
import { PromoRedemptionRepository } from "../promo/promo-redemption.repository.js";
import { PromoUserUsageRepository } from "../promo/promo-user-usage.repository.js";
import { ServiceRepository } from "../services/service.repository.js";
import { SessionRepository } from "../session/session.repository.js";
import { StaffRepository } from "../staff/staff.repository.js";
import { StaffScheduleRepository } from "../staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../staff/staff-time-off.repository.js";
import { createDeferredStorageServiceFromEnv } from "../storage/storage.service.js";
import { UserRepository } from "../user/user.repository.js";
import { BookAgainController } from "./book-again.controller.js";
import { BookAgainService } from "./book-again.service.js";
import { BookingController } from "./booking.controller.js";
import { BookingRepository } from "./booking.repository.js";
import {
  bookingBusinessParamsSchema,
  bookingIdOnlyParamsSchema,
  bookingIdParamsSchema,
  calendarQuerySchema,
  cancelBookingBodySchema,
  completeBookingBodySchema,
  createCustomerBookingPreviewBodySchema,
  createManualBookingBodySchema,
  listBusinessBookingsQuerySchema,
  listCustomerBookingsQuerySchema,
  markNoShowBodySchema,
  rescheduleBookingBodySchema,
  waiveFeeBodySchema,
} from "./booking.schema.js";
import { BookingService } from "./booking.service.js";
import { BookingCreationService } from "./booking-creation.service.js";
import { BookingCreationClaimRepository } from "./booking-creation-claim.repository.js";
import { BookingLifecycleService } from "./booking-lifecycle.service.js";

const buildController = (): BookingController => {
  const businessRepository = new BusinessRepository();
  const staffRepository = new StaffRepository();
  const serviceRepository = new ServiceRepository();
  const addonRepository = new AddonRepository();
  const addonServiceAssignmentRepository = new AddonServiceAssignmentRepository();
  const clientRepository = new ClientRepository();
  const bookingRepository = new BookingRepository();
  const userRepository = new UserRepository();
  const staffScheduleRepository = new StaffScheduleRepository();
  const staffTimeOffRepository = new StaffTimeOffRepository();
  const businessHoursRepository = new BusinessHoursRepository();
  const businessBookingSettingsRepository = new BusinessBookingSettingsRepository();
  const businessTravelSettingsRepository = new BusinessTravelSettingsRepository();
  const businessCancellationPolicyRepository = new BusinessCancellationPolicyRepository();
  const reservationRepository = new BookingSlotReservationRepository();
  const reservationService = new BookingSlotReservationService(reservationRepository);
  const claimRepository = new BookingCreationClaimRepository();
  const paymentService = new PaymentService(
    new StripePaymentGateway(),
    new CustomerPaymentProfileRepository(),
    userRepository,
  );
  const financialTransactionService = new BookingFinancialTransactionService(
    new BookingFinancialTransactionRepository(),
  );
  const promoApplicationService = new PromoApplicationService(
    new PromoRepository(),
    new PromoUserUsageRepository(),
    new PromoRedemptionRepository(),
  );
  const integrationService = new IntegrationService(
    new IntegrationRepository(),
    businessRepository,
  );

  const availabilityService = new AvailabilityService(
    businessRepository,
    serviceRepository,
    staffRepository,
    staffScheduleRepository,
    staffTimeOffRepository,
    businessHoursRepository,
    businessBookingSettingsRepository,
    businessTravelSettingsRepository,
    reservationRepository,
  );

  const bookingService = new BookingService(
    businessRepository,
    staffRepository,
    serviceRepository,
    addonRepository,
    addonServiceAssignmentRepository,
    clientRepository,
    bookingRepository,
  );

  const platformSettingsService = new PlatformSettingsService(new PlatformSettingsRepository());

  const bookingCreatedNotifier = new BookingCreatedNotifier(
    new EmailOutboxService(),
    userRepository,
  );

  // Appointment reminders — shared across the creation and lifecycle services so a booking's
  // 24h reminder is scheduled on create, re-scheduled on reschedule, and retired on cancel/
  // complete/no-show. Delivery happens later in run-appointment-reminder-worker.ts.
  const appointmentReminderScheduler = new AppointmentReminderScheduler(
    new AppointmentReminderRepository(),
  );

  const creationService = new BookingCreationService(
    businessRepository,
    bookingService,
    availabilityService,
    reservationService,
    businessTravelSettingsRepository,
    businessCancellationPolicyRepository,
    bookingRepository,
    claimRepository,
    userRepository,
    clientRepository,
    paymentService,
    financialTransactionService,
    promoApplicationService,
    integrationService,
    platformSettingsService,
    bookingCreatedNotifier,
    appointmentReminderScheduler,
  );

  const lifecycleService = new BookingLifecycleService(
    bookingService,
    bookingRepository,
    businessRepository,
    reservationService,
    availabilityService,
    serviceRepository,
    staffRepository,
    paymentService,
    financialTransactionService,
    integrationService,
    new BookingCompletedNotifier(new EmailOutboxService()),
    new BookingCancelledNotifier(new EmailOutboxService(), userRepository),
    new NoShowNotifier(new EmailOutboxService()),
    new StaffBookingNotifier(new EmailOutboxService(), staffRepository, userRepository),
    appointmentReminderScheduler,
    new BookingRescheduledCustomerNotifier(new EmailOutboxService()),
  );

  return new BookingController(bookingService, creationService, lifecycleService);
};

const buildAuthenticate = () => {
  const userRepository = new UserRepository();
  const sessionRepository = new SessionRepository();
  const tokenService = new TokenService(sessionRepository);
  return createAuthenticateAccessTokenMiddleware(tokenService, userRepository);
};

/** Business-side Booking management — Owner-or-active-Supervisor only, mirrors
 * AvailabilityService/createAvailabilityRoute's own authorization scope exactly (reused via
 * BookingService.requireBookingManagementAccess, never duplicated). Mounted before
 * business.route.ts's router-wide Owner-only gate, same rationale as createAvailabilityRoute. */
export const createBusinessBookingRoute = (): Router => {
  const router = Router();
  const authenticate = buildAuthenticate();
  const controller = buildController();
  const businessRepository = new BusinessRepository();

  // Batch 11 — a PENDING or SUSPENDED Business cannot have a NEW manual booking created for it
  // (confirmed policy). Existing-booking lifecycle routes below (calendar/list/detail/complete/
  // no-show/waive-fee/cancel/reschedule) are deliberately NOT gated — those must always remain
  // available regardless of Business status.
  router.post(
    "/:businessId/bookings",
    authenticate,
    requireActiveUser(),
    requireRoles(["BUSINESS_OWNER", "SUPERVISOR"]),
    requireApprovedBusiness(businessRepository),
    validateRequest({ params: bookingBusinessParamsSchema, body: createManualBookingBodySchema }),
    asyncHandler(controller.createManual),
  );

  router.get(
    "/:businessId/bookings/calendar",
    authenticate,
    requireActiveUser(),
    requireRoles(["BUSINESS_OWNER", "SUPERVISOR"]),
    validateRequest({ params: bookingBusinessParamsSchema, query: calendarQuerySchema }),
    asyncHandler(controller.getCalendar),
  );

  router.get(
    "/:businessId/bookings",
    authenticate,
    requireActiveUser(),
    requireRoles(["BUSINESS_OWNER", "SUPERVISOR"]),
    validateRequest({
      params: bookingBusinessParamsSchema,
      query: listBusinessBookingsQuerySchema,
    }),
    asyncHandler(controller.listForBusiness),
  );

  router.get(
    "/:businessId/bookings/:bookingId",
    authenticate,
    requireActiveUser(),
    requireRoles(["BUSINESS_OWNER", "SUPERVISOR"]),
    validateRequest({ params: bookingIdParamsSchema }),
    asyncHandler(controller.getDetailForBusiness),
  );

  router.post(
    "/:businessId/bookings/:bookingId/complete",
    authenticate,
    requireActiveUser(),
    requireRoles(["BUSINESS_OWNER", "SUPERVISOR"]),
    validateRequest({ params: bookingIdParamsSchema, body: completeBookingBodySchema }),
    asyncHandler(controller.completeBooking),
  );

  router.post(
    "/:businessId/bookings/:bookingId/no-show",
    authenticate,
    requireActiveUser(),
    requireRoles(["BUSINESS_OWNER", "SUPERVISOR"]),
    validateRequest({ params: bookingIdParamsSchema, body: markNoShowBodySchema }),
    asyncHandler(controller.markNoShow),
  );

  // Batch 5 — generic Waive Fee flow (item 9): applies to whichever fee is currently
  // outstanding on this Booking (an active no-show timer, or a still-uncollected
  // LATE_CANCELLATION fee) — see BookingLifecycleService.waiveFee's own doc comment. Replaces
  // the narrower Batch 4 "/no-show/waive" (no-show only, no reason captured).
  router.post(
    "/:businessId/bookings/:bookingId/waive-fee",
    authenticate,
    requireActiveUser(),
    requireRoles(["BUSINESS_OWNER", "SUPERVISOR"]),
    validateRequest({ params: bookingIdParamsSchema, body: waiveFeeBodySchema }),
    asyncHandler(controller.waiveFee),
  );

  router.post(
    "/:businessId/bookings/:bookingId/no-show/cancel",
    authenticate,
    requireActiveUser(),
    requireRoles(["BUSINESS_OWNER", "SUPERVISOR"]),
    validateRequest({ params: bookingIdParamsSchema }),
    asyncHandler(controller.cancelNoShow),
  );

  router.post(
    "/:businessId/bookings/:bookingId/cancel",
    authenticate,
    requireActiveUser(),
    requireRoles(["BUSINESS_OWNER", "SUPERVISOR"]),
    validateRequest({ params: bookingIdParamsSchema, body: cancelBookingBodySchema }),
    asyncHandler(controller.cancelByBusiness),
  );

  router.post(
    "/:businessId/bookings/:bookingId/reschedule",
    authenticate,
    requireActiveUser(),
    requireRoles(["BUSINESS_OWNER", "SUPERVISOR"]),
    validateRequest({ params: bookingIdParamsSchema, body: rescheduleBookingBodySchema }),
    asyncHandler(controller.rescheduleByOwner),
  );

  // Batch 11 — a PENDING or SUSPENDED Business cannot be previewed/booked by a Customer either
  // (mirrors the catalog.route.ts gate — a Customer arriving here directly, e.g. a stale tab,
  // must not slip past the same policy the catalog read routes already enforce).
  router.post(
    "/:businessId/bookings/preview",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    requireApprovedBusiness(businessRepository),
    validateRequest({
      params: bookingBusinessParamsSchema,
      body: createCustomerBookingPreviewBodySchema,
    }),
    asyncHandler(controller.previewCustomerBooking),
  );

  // Batch 4 — the real Customer BOOKLY_MANAGED finalize path (see
  // BookingCreationService.finalizeCustomerBooking's own doc comment for the full saga).
  router.post(
    "/:businessId/bookings/finalize",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    requireApprovedBusiness(businessRepository),
    validateRequest({
      params: bookingBusinessParamsSchema,
      body: createCustomerBookingPreviewBodySchema,
    }),
    asyncHandler(controller.finalizeCustomerBooking),
  );

  return router;
};

/** Customer self-service Booking surface — authenticated CUSTOMER only, cross-business (never
 * scoped to one Business's owner-only gate), mirroring the `/auth/me` "current identity" naming
 * convention already established in this codebase. */
export const createCustomerBookingRoute = (): Router => {
  const router = Router();
  const authenticate = buildAuthenticate();
  const controller = buildController();
  const bookAgainController = new BookAgainController(
    new BookAgainService(
      new BookingRepository(),
      new BusinessRepository(),
      new BusinessMediaRepository(),
      createDeferredStorageServiceFromEnv(),
    ),
  );

  router.get(
    "/bookings",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    validateRequest({ query: listCustomerBookingsQuerySchema }),
    asyncHandler(controller.listForCustomer),
  );

  // Batch 16 — Book Again. Registered BEFORE "/bookings/:bookingId" so the literal path segment
  // "book-again" is never swallowed by that param route (which would otherwise 400 it as an
  // invalid ObjectId — Express matches by registration order for overlapping patterns).
  router.get(
    "/bookings/book-again",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    validateRequest({ query: listCustomerBookingsQuerySchema }),
    asyncHandler(bookAgainController.list),
  );

  router.get(
    "/bookings/:bookingId",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    validateRequest({ params: bookingIdOnlyParamsSchema }),
    asyncHandler(controller.getDetailForCustomer),
  );

  router.post(
    "/bookings/:bookingId/cancel",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    validateRequest({ params: bookingIdOnlyParamsSchema, body: cancelBookingBodySchema }),
    asyncHandler(controller.cancelByCustomer),
  );

  router.post(
    "/bookings/:bookingId/reschedule",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    validateRequest({ params: bookingIdOnlyParamsSchema, body: rescheduleBookingBodySchema }),
    asyncHandler(controller.rescheduleByCustomer),
  );

  return router;
};
