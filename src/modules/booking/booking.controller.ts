import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type { PackageProgressBusinessParams } from "../package-progress/package-progress.schema.js";
import type { UserRole } from "../user/user.types.js";
import {
  toBookingCalendarEntryDto,
  toBookingDetailDto,
  toBookingListItemDto,
} from "./booking.dto.js";
import { BookingError } from "./booking.errors.js";
import type {
  BookingBusinessParams,
  BookingIdOnlyParams,
  BookingIdParams,
  BookingServiceParams,
  CalendarQuery,
  CancelBookingBody,
  CompleteBookingBody,
  CreateCustomerBookingPreviewBody,
  CreateManualBookingBody,
  ListBusinessBookingsQuery,
  ListCustomerBookingsQuery,
  MarkNoShowBody,
  PackagePurchaseBody,
  PackageRedemptionPreviewBody,
  RedeemPackageSessionBody,
  RescheduleAvailabilityQuery,
  RescheduleBookingBody,
  VoidPackageBody,
  WaiveFeeBody,
} from "./booking.schema.js";
import type { BookingService } from "./booking.service.js";
import type { BookingCreationService } from "./booking-creation.service.js";
import type { BookingLifecycleService } from "./booking-lifecycle.service.js";
import type { BookingRescheduleAvailabilityService } from "./booking-reschedule-availability.service.js";
import type { CustomerFinancialOutcomeRead } from "./customer-financial-outcome.read.js";

export class BookingController {
  public constructor(
    private readonly bookingService: BookingService,
    private readonly creationService: BookingCreationService,
    private readonly lifecycleService: BookingLifecycleService,
    private readonly rescheduleAvailability?: BookingRescheduleAvailabilityService,
    private readonly financialOutcomeRead?: CustomerFinancialOutcomeRead,
  ) {}

  // --- Business-side ------------------------------------------------------------------------

  public getRescheduleAvailabilityForBusiness = async (
    request: Request,
    response: Response,
  ): Promise<void> => {
    const { userId, role } = this.requireBusinessActor(request);
    const params = request.validated?.params as BookingIdParams;
    const query = request.validated?.query as RescheduleAvailabilityQuery;
    if (!this.rescheduleAvailability)
      throw new BookingError("BOOKING_TRANSACTION_UNAVAILABLE", 503);
    const result = await this.rescheduleAvailability.forBusiness(
      userId,
      role as "BUSINESS_OWNER" | "SUPERVISOR",
      params.businessId,
      params.bookingId,
      query.fromDate,
      query.toDate,
    );
    sendSuccess(response, 200, "Reschedule availability", result);
  };

  public getRescheduleAvailabilityForCustomer = async (
    request: Request,
    response: Response,
  ): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const params = request.validated?.params as BookingIdOnlyParams;
    const query = request.validated?.query as RescheduleAvailabilityQuery;
    if (!this.rescheduleAvailability)
      throw new BookingError("BOOKING_TRANSACTION_UNAVAILABLE", 503);
    const result = await this.rescheduleAvailability.forCustomer(
      userId,
      params.bookingId,
      query.fromDate,
      query.toDate,
    );
    sendSuccess(response, 200, "Reschedule availability", result);
  };

  public createManual = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireBusinessActor(request);
    const params = request.validated?.params as BookingBusinessParams;
    const body = request.validated?.body as CreateManualBookingBody;

    const booking = await this.creationService.createManualBooking(
      userId,
      role,
      params.businessId,
      {
        serviceLines: body.serviceLines,
        startAt: body.startAt,
        travelAddress: body.travelAddress,
        customerCity: body.customerCity,
        notes: body.notes,
        idempotencyKey: body.idempotencyKey,
        businessClientId: body.businessClientId,
      },
    );

    sendSuccess(response, 201, "Booking created", toBookingDetailDto(booking));
  };

  /** Read-only manual-booking picker data (Owner-or-Supervisor) — see BookingService's own
   * "Manual-booking read context" doc comment for why this exists instead of reusing the
   * Owner-only Service-management list. */
  public listBookableServices = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireBusinessActor(request);
    const params = request.validated?.params as BookingBusinessParams;

    const services = await this.bookingService.listBookableServices(
      userId,
      role,
      params.businessId,
    );

    sendSuccess(response, 200, "Bookable services", { services });
  };

  public listBookableAddonsForService = async (
    request: Request,
    response: Response,
  ): Promise<void> => {
    const { userId, role } = this.requireBusinessActor(request);
    const params = request.validated?.params as BookingServiceParams;

    const addons = await this.bookingService.listBookableAddonsForService(
      userId,
      role,
      params.businessId,
      params.serviceId,
    );

    sendSuccess(response, 200, "Bookable add-ons", { addons });
  };

  public getDetailForBusiness = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireBusinessActor(request);
    const params = request.validated?.params as BookingIdParams;

    const booking = await this.bookingService.getBookingDetailForBusiness(
      userId,
      role,
      params.businessId,
      params.bookingId,
    );
    const packageProgressContexts =
      await this.bookingService.getPackageProgressContextsForBusinessBooking(booking);

    sendSuccess(response, 200, "Booking", toBookingDetailDto(booking, packageProgressContexts));
  };

  public listForBusiness = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireBusinessActor(request);
    const params = request.validated?.params as BookingBusinessParams;
    const query = request.validated?.query as ListBusinessBookingsQuery;

    const result = await this.bookingService.listBookingsForBusiness(
      userId,
      role,
      params.businessId,
      {
        status: query.status,
        staffMembershipId: query.staffMembershipId,
        businessClientId: query.businessClientId,
        fromDate: query.fromDate,
        toDate: query.toDate,
      },
      { page: query.page, limit: query.limit },
    );

    sendSuccess(response, 200, "Bookings", {
      bookings: result.bookings.map(toBookingListItemDto),
      pagination: { page: query.page, limit: query.limit, total: result.total },
    });
  };

  public getCalendar = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireBusinessActor(request);
    const params = request.validated?.params as BookingBusinessParams;
    const query = request.validated?.query as CalendarQuery;

    const bookings = await this.bookingService.getCalendarForBusiness(
      userId,
      role,
      params.businessId,
      new Date(query.fromDate),
      new Date(query.toDate),
    );

    sendSuccess(response, 200, "Calendar", { bookings: bookings.map(toBookingCalendarEntryDto) });
  };

  public completeBooking = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireBusinessActor(request);
    const params = request.validated?.params as BookingIdParams;
    const body = request.validated?.body as CompleteBookingBody;

    const booking = await this.lifecycleService.completeBooking(
      userId,
      role,
      params.businessId,
      params.bookingId,
      body.venuePayment,
    );

    sendSuccess(response, 200, "Booking completed", toBookingDetailDto(booking));
  };

  public markNoShow = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireBusinessActor(request);
    const params = request.validated?.params as BookingIdParams;
    const body = (request.validated?.body ?? {}) as MarkNoShowBody;

    const booking = await this.lifecycleService.markNoShow(
      userId,
      role,
      params.businessId,
      params.bookingId,
      body.reason,
      body.internalNote,
    );

    sendSuccess(response, 200, "Booking marked as no-show", toBookingDetailDto(booking));
  };

  public waiveFee = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireBusinessActor(request);
    const params = request.validated?.params as BookingIdParams;
    const body = request.validated?.body as WaiveFeeBody;

    const booking = await this.lifecycleService.waiveFee(
      userId,
      role,
      params.businessId,
      params.bookingId,
      body.reason,
      body.internalNote,
    );

    sendSuccess(response, 200, "Fee waived", toBookingDetailDto(booking));
  };

  public cancelNoShow = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireBusinessActor(request);
    const params = request.validated?.params as BookingIdParams;

    const booking = await this.lifecycleService.cancelNoShowByBusiness(
      userId,
      role,
      params.businessId,
      params.bookingId,
    );

    sendSuccess(response, 200, "No-show cancelled", toBookingDetailDto(booking));
  };

  public cancelByBusiness = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireBusinessActor(request);
    const params = request.validated?.params as BookingIdParams;
    const body = request.validated?.body as CancelBookingBody;

    const booking = await this.lifecycleService.cancelByBusiness(
      userId,
      role,
      params.businessId,
      params.bookingId,
      body.reason,
    );

    sendSuccess(response, 200, "Booking cancelled", toBookingDetailDto(booking));
  };

  public rescheduleByOwner = async (request: Request, response: Response): Promise<void> => {
    const { userId, role } = this.requireBusinessActor(request);
    const params = request.validated?.params as BookingIdParams;
    const body = request.validated?.body as RescheduleBookingBody;

    const booking = await this.lifecycleService.rescheduleByOwner(
      userId,
      role,
      params.businessId,
      params.bookingId,
      body.startAt,
    );

    sendSuccess(response, 200, "Booking rescheduled", toBookingDetailDto(booking));
  };

  // --- Customer-side -------------------------------------------------------------------------

  public previewCustomerBooking = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const params = request.validated?.params as BookingBusinessParams;
    const body = request.validated?.body as CreateCustomerBookingPreviewBody;

    const preview = await this.creationService.previewCustomerBooking(userId, params.businessId, {
      serviceLines: body.serviceLines,
      startAt: body.startAt,
      travelAddress: body.travelAddress,
      customerCity: body.customerCity,
      notes: body.notes,
      idempotencyKey: body.idempotencyKey,
      promoCode: body.promoCode,
    });

    sendSuccess(response, 200, "Booking preview", preview);
  };

  public finalizeCustomerBooking = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const params = request.validated?.params as BookingBusinessParams;
    const body = request.validated?.body as CreateCustomerBookingPreviewBody;

    const result = await this.creationService.finalizeCustomerBooking(userId, params.businessId, {
      serviceLines: body.serviceLines,
      startAt: body.startAt,
      travelAddress: body.travelAddress,
      customerCity: body.customerCity,
      notes: body.notes,
      idempotencyKey: body.idempotencyKey,
      promoCode: body.promoCode,
    });

    if (result.status === "requires_action") {
      sendSuccess(response, 200, "Payment requires additional authentication", result);
      return;
    }

    sendSuccess(response, 201, "Booking confirmed", toBookingDetailDto(result.booking));
  };

  // --- Customer-side: Package purchase / session redemption ----------------------------------

  public previewPackagePurchase = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const params = request.validated?.params as BookingBusinessParams;
    const body = request.validated?.body as PackagePurchaseBody;

    const preview = await this.creationService.previewPackagePurchase(userId, params.businessId, {
      serviceLines: body.serviceLines,
      startAt: body.startAt,
      travelAddress: body.travelAddress,
      customerCity: body.customerCity,
      notes: body.notes,
      idempotencyKey: body.idempotencyKey,
    });

    sendSuccess(response, 200, "Package purchase preview", preview);
  };

  public finalizePackagePurchase = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const params = request.validated?.params as BookingBusinessParams;
    const body = request.validated?.body as PackagePurchaseBody;

    const result = await this.creationService.finalizePackagePurchase(userId, params.businessId, {
      serviceLines: body.serviceLines,
      startAt: body.startAt,
      travelAddress: body.travelAddress,
      customerCity: body.customerCity,
      notes: body.notes,
      idempotencyKey: body.idempotencyKey,
    });

    if (result.status === "requires_action") {
      sendSuccess(response, 200, "Payment requires additional authentication", result);
      return;
    }

    sendSuccess(response, 201, "Package purchased", toBookingDetailDto(result.booking));
  };

  public previewPackageRedemption = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const params = request.validated?.params as PackageProgressBusinessParams;
    const body = request.validated?.body as PackageRedemptionPreviewBody;
    const preview = await this.creationService.previewPackageRedemption(
      userId,
      params.businessId,
      params.packageProgressId,
      body,
    );
    sendSuccess(response, 200, "Package redemption preview", preview);
  };

  public redeemPackageSession = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const params = request.validated?.params as PackageProgressBusinessParams;
    const body = request.validated?.body as RedeemPackageSessionBody;

    const result = await this.creationService.redeemPackageSession(
      userId,
      params.businessId,
      params.packageProgressId,
      {
        staffMembershipId: body.staffMembershipId,
        startAt: body.startAt,
        addonIds: body.addonIds,
        travelAddress: body.travelAddress,
        customerCity: body.customerCity,
        notes: body.notes,
        idempotencyKey: body.idempotencyKey,
      },
    );

    if (result.status === "requires_action") {
      sendSuccess(response, 200, "Payment requires additional authentication", result);
      return;
    }

    sendSuccess(response, 201, "Session booked", toBookingDetailDto(result.booking));
  };

  /** Whole-Package refund/void (approved rule) — see BookingLifecycleService.voidUnusedPackage's
   * own doc comment for the full eligibility rule. Returns just the entitlement's own updated
   * fields (never a Booking DTO — voiding may resolve zero, one, or leave several Bookings
   * untouched depending on what was actually scheduled). */
  private requirePackageActor(request: Request): { userId: string; role: UserRole } {
    if (request.auth?.role === "CUSTOMER")
      return { userId: this.requireCustomerId(request), role: "CUSTOMER" };
    return this.requireBusinessActor(request);
  }

  public getPackageForBusiness = async (request: Request, response: Response): Promise<void> => {
    const actor = this.requireBusinessActor(request);
    const params = request.validated?.params as PackageProgressBusinessParams;
    sendSuccess(
      response,
      200,
      "Package",
      await this.lifecycleService.getPackageForBusiness(
        actor.userId,
        actor.role,
        params.businessId,
        params.packageProgressId,
      ),
    );
  };

  public packageAction =
    (action: "CANCEL_FUTURE" | "TERMINATE") =>
    async (request: Request, response: Response): Promise<void> => {
      const actor = this.requirePackageActor(request);
      const params = request.validated?.params as PackageProgressBusinessParams;
      const body = request.validated?.body as CancelBookingBody;
      const result = await this.lifecycleService.packageAction(
        actor.userId,
        actor.role,
        params.businessId,
        params.packageProgressId,
        action,
        body.reason,
      );
      sendSuccess(
        response,
        200,
        action === "TERMINATE" ? "Package cancelled" : "Future appointments cancelled",
        {
          packageProgressId: String(result.packageProgress._id),
          voidedAt: result.packageProgress.voidedAt?.toISOString(),
          cancelledBookingIds: result.cancelledBookingIds,
          remainingSessions: result.packageProgress.remainingSessions,
          availableSessions: result.packageProgress.voidedAt
            ? 0
            : result.packageProgress.remainingSessions,
          refundSettlement: result.packageProgress.voidRefundSettlement,
        },
      );
    };

  public voidPackage = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const params = request.validated?.params as PackageProgressBusinessParams;
    const body = request.validated?.body as VoidPackageBody;

    const voided = await this.lifecycleService.voidUnusedPackage(
      userId,
      params.businessId,
      params.packageProgressId,
      body.reason,
    );

    sendSuccess(response, 200, "Package cancelled", {
      packageProgressId: String(voided._id),
      voidedAt: voided.voidedAt?.toISOString(),
      remainingSessions: voided.remainingSessions,
      availableSessions: 0,
      refundSettlement: voided.voidRefundSettlement,
      totalSessions: voided.totalSessions,
    });
  };

  public getDetailForCustomer = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const params = request.validated?.params as BookingIdOnlyParams;

    const booking = await this.bookingService.getBookingDetailForCustomer(userId, params.bookingId);

    const detail = this.financialOutcomeRead
      ? await this.financialOutcomeRead.forOwnedBooking(userId, booking)
      : { booking };
    sendSuccess(response, 200, "Booking", {
      ...toBookingDetailDto(detail.booking),
      ...("financialOutcome" in detail && detail.financialOutcome
        ? { financialOutcome: detail.financialOutcome }
        : {}),
    });
  };

  public listForCustomer = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const query = request.validated?.query as ListCustomerBookingsQuery;

    const result = await this.bookingService.listBookingsForCustomer(
      userId,
      {
        status: query.status,
        source: query.source,
        fromDate: query.fromDate,
        toDate: query.toDate,
      },
      { page: query.page, limit: query.limit },
    );

    sendSuccess(response, 200, "My bookings", {
      bookings: result.bookings.map(toBookingListItemDto),
      pagination: { page: query.page, limit: query.limit, total: result.total },
    });
  };

  public cancelByCustomer = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const params = request.validated?.params as BookingIdOnlyParams;
    const body = request.validated?.body as CancelBookingBody;

    const booking = await this.lifecycleService.cancelByCustomer(
      userId,
      params.bookingId,
      body.reason,
    );

    sendSuccess(response, 200, "Booking cancelled", toBookingDetailDto(booking));
  };

  public rescheduleByCustomer = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const params = request.validated?.params as BookingIdOnlyParams;
    const body = request.validated?.body as RescheduleBookingBody;

    const booking = await this.lifecycleService.rescheduleByCustomer(
      userId,
      params.bookingId,
      body.startAt,
    );

    sendSuccess(response, 200, "Booking rescheduled", toBookingDetailDto(booking));
  };

  // --- Auth helpers ---------------------------------------------------------------------------

  private requireBusinessActor(request: Request): { userId: string; role: UserRole } {
    const userId = request.auth?.userId;
    const role = request.auth?.role;

    if (!userId || (role !== "BUSINESS_OWNER" && role !== "SUPERVISOR")) {
      throw new AuthError("PORTAL_MISMATCH", 403);
    }

    return { userId, role };
  }

  private requireCustomerId(request: Request): string {
    const userId = request.auth?.userId;
    const role = request.auth?.role;

    if (!userId || role !== "CUSTOMER") {
      throw new AuthError("PORTAL_MISMATCH", 403);
    }

    return userId;
  }
}
