import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { businessLocalToUtc } from "../../../src/common/time/business-clock.js";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import { AvailabilityService } from "../../../src/modules/availability/availability.service.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { BookingService } from "../../../src/modules/booking/booking.service.js";
import { BookingCreationService } from "../../../src/modules/booking/booking-creation.service.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import { BookingFinancialTransactionRepository } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { BookingSlotReservationRepository } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.repository.js";
import { BookingSlotReservationService } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.service.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessBookingSettingsRepository } from "../../../src/modules/business-booking-settings/business-booking-settings.repository.js";
import { BusinessCancellationPolicyRepository } from "../../../src/modules/business-cancellation-policy/business-cancellation-policy.repository.js";
import { BusinessHoursRepository } from "../../../src/modules/business-hours/business-hours.repository.js";
import { BusinessHoursService } from "../../../src/modules/business-hours/business-hours.service.js";
import { BusinessTravelSettingsRepository } from "../../../src/modules/business-travel-settings/business-travel-settings.repository.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { PromoRepository } from "../../../src/modules/promo/promo.repository.js";
import { PromoApplicationService } from "../../../src/modules/promo/promo-application.service.js";
import { PromoRedemptionRepository } from "../../../src/modules/promo/promo-redemption.repository.js";
import { PromoUserUsageRepository } from "../../../src/modules/promo/promo-user-usage.repository.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../../../src/modules/staff/staff-time-off.repository.js";
import { SupportService } from "../../../src/modules/support/support.service.js";
import type { SupportEmailProvider } from "../../../src/modules/support/support-email.provider.js";
import { SupportMessageRepository } from "../../../src/modules/support/support-message.repository.js";
import { SupportTicketRepository } from "../../../src/modules/support/support-ticket.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { FakePaymentGateway } from "../../helpers/fake-payment-gateway.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const TIMEZONE = "Europe/Nicosia";
const DATE = "2030-08-20"; // a Tuesday, safely in the future relative to any real "now"

/** Records every attempted send instead of touching the network — deliberately throws by
 * default so tests can prove "email best-effort never fails the surrounding request" (item 27/28
 * of the batch spec), matching FakePaymentGateway's own precedent for this codebase. */
class FakeSupportEmailProvider implements SupportEmailProvider {
  public sent: Array<{ to: string; subject: string; text: string }> = [];
  public shouldFail = false;

  public async send(input: { to: string; subject: string; text: string }): Promise<void> {
    if (this.shouldFail) {
      throw new Error("simulated delivery failure");
    }
    this.sent.push(input);
  }
}

/**
 * Batch 15B — Support & Issues, domain-level correctness. Every Booking used for the
 * booking-linkage tests is produced by the REAL booking-creation pipeline (matching Review's own
 * fixture discipline — see review-database.integration.test.ts).
 */
describe("database-backed Support domain (Batch 15B)", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let serviceRepository: ServiceRepository;
  let staffRepository: StaffRepository;
  let staffScheduleRepository: StaffScheduleRepository;
  let businessHoursService: BusinessHoursService;
  let clientRepository: ClientRepository;
  let bookingRepository: BookingRepository;
  let creationService: BookingCreationService;
  let paymentService: PaymentService;
  let supportTicketRepository: SupportTicketRepository;
  let supportMessageRepository: SupportMessageRepository;
  let emailProvider: FakeSupportEmailProvider;
  let supportService: SupportService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    serviceRepository = new ServiceRepository();
    staffRepository = new StaffRepository();
    staffScheduleRepository = new StaffScheduleRepository();
    const businessHoursRepository = new BusinessHoursRepository();
    businessHoursService = new BusinessHoursService(businessHoursRepository, businessRepository);
    clientRepository = new ClientRepository();
    const reservationRepository = new BookingSlotReservationRepository();
    const reservationService = new BookingSlotReservationService(reservationRepository);
    bookingRepository = new BookingRepository();
    const paymentGateway = new FakePaymentGateway();
    paymentService = new PaymentService(
      paymentGateway,
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

    const availabilityService = new AvailabilityService(
      businessRepository,
      serviceRepository,
      staffRepository,
      staffScheduleRepository,
      new StaffTimeOffRepository(),
      businessHoursRepository,
      new BusinessBookingSettingsRepository(),
      new BusinessTravelSettingsRepository(),
      reservationRepository,
    );

    const bookingService = new BookingService(
      businessRepository,
      staffRepository,
      serviceRepository,
      new AddonRepository(),
      new AddonServiceAssignmentRepository(),
      clientRepository,
      bookingRepository,
    );

    creationService = new BookingCreationService(
      businessRepository,
      bookingService,
      availabilityService,
      reservationService,
      new BusinessTravelSettingsRepository(),
      new BusinessCancellationPolicyRepository(),
      bookingRepository,
      new BookingCreationClaimRepository(),
      userRepository,
      clientRepository,
      paymentService,
      financialTransactionService,
      promoApplicationService,
    );

    supportTicketRepository = new SupportTicketRepository();
    supportMessageRepository = new SupportMessageRepository();
    emailProvider = new FakeSupportEmailProvider();
    supportService = new SupportService(
      supportTicketRepository,
      supportMessageRepository,
      bookingRepository,
      businessRepository,
      staffRepository,
      userRepository,
      emailProvider,
    );
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Fixtures --------------------------------------------------------------------------------

  const createBusiness = async (name: string) => {
    const email = `owner-${new Types.ObjectId().toString()}@example.com`;
    const owner = await userRepository.create({
      normalizedEmail: email,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const pending = await businessRepository.create({
      ownerUserId: owner._id,
      name,
      ownerName: "Owner Name",
      email,
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: "AT_BUSINESS_LOCATION",
      timezone: TIMEZONE,
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      briefDescription: "A great business",
      category: "Barber",
      subcategories: ["Haircut"],
    });
    const business = await businessRepository.casUpdateStatus(
      pending._id,
      ["PENDING"],
      "APPROVED",
      { fromStatus: "PENDING", actorUserId: owner._id, changedAt: new Date() },
    );
    return { owner, business: business ?? pending };
  };

  const createStaffMember = async (
    businessId: Types.ObjectId,
    role: "STAFF" | "SUPERVISOR" = "STAFF",
  ) => {
    const user = await userRepository.create({
      normalizedEmail: `staff-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role,
      status: "ACTIVE",
    });
    const membership = await staffRepository.create({
      userId: user._id,
      businessId,
      role,
      createdByUserId: user._id,
    });
    return { user, membership };
  };

  const createCustomer = async (tag: string) =>
    userRepository.create({
      normalizedEmail: `cust-${tag}-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });

  const saveCard = async (userId: Types.ObjectId) => {
    const setupIntent = await paymentService.createSetupIntent(String(userId));
    await paymentService.confirmSavedPaymentMethod(String(userId), setupIntent.setupIntentId);
  };

  const linkCustomerToBusiness = async (
    businessId: Types.ObjectId,
    ownerId: Types.ObjectId,
    customerId: Types.ObjectId,
  ) => {
    const user = await userRepository.findById(customerId);
    const nationalNumber = `9${customerId.toString().slice(-7)}`;
    return clientRepository.create({
      businessId,
      createdByUserId: ownerId,
      firstName: "Maria",
      lastName: "Khan",
      normalizedEmail: user?.normalizedEmail ?? `linked-${customerId.toString()}@example.com`,
      phone: { countryCode: "+357", nationalNumber, e164: `+357${nationalNumber}` },
      address: {
        city: "Larnaca",
        propertyType: "House",
        area: "Center",
        streetName: "Main",
        streetNumber: "1",
      },
      linkState: "LINKED",
      linkedUserId: customerId,
    });
  };

  const startAtFor = (time: string) => businessLocalToUtc(TIMEZONE, DATE, time).toISOString();

  /** Produces a real CONFIRMED BOOKLY_MANAGED booking end to end — Support's booking-linkage
   * check never cares about the Booking's status, only that it genuinely belongs to the actor. */
  const createBookingForCustomer = async (customerId: Types.ObjectId, time = "10:00") => {
    const { owner, business } = await createBusiness("Salon Support");
    const { membership } = await createStaffMember(business._id);
    const service = await serviceRepository.create({
      businessId: business._id,
      status: "ACTIVE",
      isFeatured: false,
      isPackageDeal: false,
      category: "Barber",
      name: "Haircut",
      pricingMode: "FIXED",
      fixedPricing: { priceCents: 8000, durationMin: 60, bookingIntervalMin: 60 },
      sessionExpiryAlert: { enabled: false },
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities: [],
      assignedStaffMembershipIds: [membership._id],
    });
    const days = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] as const;
    await businessHoursService.putOpeningHours(String(owner._id), String(business._id), [
      ...days.map((dayOfWeek) => ({
        dayOfWeek,
        isOpen: true,
        slots: [{ startTime: "09:00", endTime: "18:00" }],
      })),
      { dayOfWeek: "SATURDAY", isOpen: false, slots: [] },
      { dayOfWeek: "SUNDAY", isOpen: false, slots: [] },
    ]);
    await staffScheduleRepository.replace(
      membership._id,
      business._id,
      days.map((dayOfWeek) => ({ dayOfWeek, startTime: "09:00", endTime: "18:00" })),
    );
    await saveCard(customerId);
    await linkCustomerToBusiness(business._id, owner._id, customerId);

    const result = await creationService.finalizeCustomerBooking(
      String(customerId),
      String(business._id),
      {
        serviceLines: [
          {
            serviceId: String(service._id),
            staffMembershipId: String(membership._id),
            addonIds: [],
            pricingInput: {},
          },
        ],
        startAt: startAtFor(time),
        idempotencyKey: `key-${new Types.ObjectId().toString()}`,
      },
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");
    return { owner, business, membership, service, booking: result.booking };
  };

  // --- Creation + businessId resolution ---------------------------------------------------------

  it("CUSTOMER can create a ticket — no businessId, requesterRole CUSTOMER, status OPEN, real reference", async () => {
    const customer = await createCustomer("create");
    const ticket = await supportService.createTicket(String(customer._id), "CUSTOMER", {
      subject: "Payment issue",
      message: "I was charged twice",
    });

    expect(ticket.requesterRole).toBe("CUSTOMER");
    expect(ticket.businessId).toBeUndefined();
    expect(ticket.status).toBe("OPEN");
    expect(ticket.reference).toMatch(/^TCK-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
    expect(ticket.statusHistory).toHaveLength(1);
    expect(ticket.statusHistory[0]?.action).toBe("CREATED");

    const messages = await supportMessageRepository.listByTicketId(ticket._id, {
      page: 1,
      limit: 10,
    });
    expect(messages.total).toBe(1);
    expect(messages.messages[0]?.message).toBe("I was charged twice");
  });

  it("BUSINESS_OWNER's ticket is server-scoped to their OWNED Business, never client-supplied", async () => {
    const { owner, business } = await createBusiness("Owner Biz");
    const ticket = await supportService.createTicket(String(owner._id), "BUSINESS_OWNER", {
      subject: "Payout question",
      message: "When is my next payout?",
    });
    expect(String(ticket.businessId)).toBe(String(business._id));
  });

  it("SUPERVISOR's ticket is server-scoped to their real active membership's Business", async () => {
    const { business } = await createBusiness("Supervisor Biz");
    const { user: supervisor } = await createStaffMember(business._id, "SUPERVISOR");
    const ticket = await supportService.createTicket(String(supervisor._id), "SUPERVISOR", {
      subject: "Schedule question",
      message: "Need help with shifts",
    });
    expect(String(ticket.businessId)).toBe(String(business._id));
  });

  it("STAFF's ticket is server-scoped to their real active membership's Business", async () => {
    const { business } = await createBusiness("Staff Biz");
    const { user: staffUser } = await createStaffMember(business._id, "STAFF");
    const ticket = await supportService.createTicket(String(staffUser._id), "STAFF", {
      subject: "App login issue",
      message: "Cannot log in on mobile",
    });
    expect(String(ticket.businessId)).toBe(String(business._id));
  });

  it("a BUSINESS_OWNER account with no resolvable Business is rejected, not silently ticketed", async () => {
    const orphanOwner = await userRepository.create({
      normalizedEmail: `orphan-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    await expect(
      supportService.createTicket(String(orphanOwner._id), "BUSINESS_OWNER", {
        subject: "x",
        message: "y",
      }),
    ).rejects.toThrow();
  });

  it("a STAFF/SUPERVISOR account with no active membership is rejected", async () => {
    const orphanStaff = await userRepository.create({
      normalizedEmail: `orphan-staff-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "STAFF",
      status: "ACTIVE",
    });
    await expect(
      supportService.createTicket(String(orphanStaff._id), "STAFF", {
        subject: "x",
        message: "y",
      }),
    ).rejects.toThrow();
  });

  // --- "My Tickets" scoping + anti-enumeration ---------------------------------------------------

  it("a requester's 'My Tickets' list contains only their OWN tickets", async () => {
    const customerA = await createCustomer("list-a");
    const customerB = await createCustomer("list-b");
    await supportService.createTicket(String(customerA._id), "CUSTOMER", {
      subject: "A's ticket",
      message: "a",
    });
    await supportService.createTicket(String(customerB._id), "CUSTOMER", {
      subject: "B's ticket",
      message: "b",
    });

    const result = await supportService.listOwnTickets(String(customerA._id), {
      page: 1,
      limit: 10,
    });
    expect(result.total).toBe(1);
    expect(result.tickets[0]?.subject).toBe("A's ticket");
  });

  it("reading another requester's ticket returns the SAME error as an unknown ticketId (anti-enumeration)", async () => {
    const owner = await createCustomer("anon-owner");
    const stranger = await createCustomer("anon-stranger");
    const ticket = await supportService.createTicket(String(owner._id), "CUSTOMER", {
      subject: "private",
      message: "m",
    });

    let unknownError: unknown;
    let foreignError: unknown;
    try {
      await supportService.getOwnTicket(String(new Types.ObjectId()), String(stranger._id));
    } catch (error) {
      unknownError = error;
    }
    try {
      await supportService.getOwnTicket(String(ticket._id), String(stranger._id));
    } catch (error) {
      foreignError = error;
    }

    expect((unknownError as { statusCode?: number })?.statusCode).toBe(404);
    expect((foreignError as { statusCode?: number })?.statusCode).toBe(404);
    expect((unknownError as Error)?.message).toBe((foreignError as Error)?.message);
  });

  // --- Reply gating ------------------------------------------------------------------------------

  it("a requester can reply while the ticket is OPEN", async () => {
    const customer = await createCustomer("reply-open");
    const ticket = await supportService.createTicket(String(customer._id), "CUSTOMER", {
      subject: "s",
      message: "first",
    });
    const reply = await supportService.replyAsRequester(
      String(ticket._id),
      String(customer._id),
      "CUSTOMER",
      "a follow-up",
    );
    expect(reply.message).toBe("a follow-up");
    expect(reply.senderRole).toBe("CUSTOMER");
  });

  it("a reply is rejected once the ticket is RESOLVED, and again once CLOSED", async () => {
    const customer = await createCustomer("reply-blocked");
    const admin = String(new Types.ObjectId());
    const ticket = await supportService.createTicket(String(customer._id), "CUSTOMER", {
      subject: "s",
      message: "m",
    });
    await supportService.changeStatus(String(ticket._id), admin, "RESOLVED");

    await expect(
      supportService.replyAsRequester(String(ticket._id), String(customer._id), "CUSTOMER", "x"),
    ).rejects.toThrow();

    await supportService.changeStatus(String(ticket._id), admin, "CLOSED");
    await expect(
      supportService.replyAsRequester(String(ticket._id), String(customer._id), "CUSTOMER", "x"),
    ).rejects.toThrow();
  });

  it("Admin reply is also rejected on a RESOLVED/CLOSED ticket", async () => {
    const customer = await createCustomer("admin-reply-blocked");
    const admin = String(new Types.ObjectId());
    const ticket = await supportService.createTicket(String(customer._id), "CUSTOMER", {
      subject: "s",
      message: "m",
    });
    await supportService.changeStatus(String(ticket._id), admin, "RESOLVED");

    await expect(
      supportService.replyAsAdmin(String(ticket._id), admin, "we're on it"),
    ).rejects.toThrow();
  });

  it("conversation messages persist in deterministic creation order across requester and admin", async () => {
    const customer = await createCustomer("order");
    const admin = String(new Types.ObjectId());
    const ticket = await supportService.createTicket(String(customer._id), "CUSTOMER", {
      subject: "s",
      message: "first message",
    });
    await supportService.replyAsAdmin(String(ticket._id), admin, "admin reply");
    await supportService.replyAsRequester(
      String(ticket._id),
      String(customer._id),
      "CUSTOMER",
      "requester follow-up",
    );

    const result = await supportService.listOwnMessages(String(ticket._id), String(customer._id), {
      page: 1,
      limit: 10,
    });
    expect(result.messages.map((m) => m.message)).toEqual([
      "first message",
      "admin reply",
      "requester follow-up",
    ]);
    expect(result.messages.map((m) => m.senderRole)).toEqual([
      "CUSTOMER",
      "SUPER_ADMIN",
      "CUSTOMER",
    ]);
  });

  it("message listing is server-paginated, never fetching an unbounded conversation", async () => {
    const customer = await createCustomer("paginate");
    const admin = String(new Types.ObjectId());
    const ticket = await supportService.createTicket(String(customer._id), "CUSTOMER", {
      subject: "s",
      message: "m0",
    });
    for (let i = 1; i <= 4; i += 1) {
      await supportService.replyAsAdmin(String(ticket._id), admin, `m${i}`);
    }

    const page1 = await supportService.listOwnMessages(String(ticket._id), String(customer._id), {
      page: 1,
      limit: 2,
    });
    expect(page1.messages).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.messages.map((m) => m.message)).toEqual(["m0", "m1"]);

    const page2 = await supportService.listOwnMessages(String(ticket._id), String(customer._id), {
      page: 2,
      limit: 2,
    });
    expect(page2.messages.map((m) => m.message)).toEqual(["m2", "m3"]);
  });

  // --- Controlled status lifecycle ----------------------------------------------------------------

  it("regular admin transitions: OPEN->PENDING, PENDING->OPEN, OPEN->RESOLVED, PENDING->RESOLVED, RESOLVED->CLOSED all succeed", async () => {
    const admin = String(new Types.ObjectId());

    const t1 = await makeTicket("t1");
    const afterPending = await supportService.changeStatus(String(t1._id), admin, "PENDING");
    expect(afterPending.status).toBe("PENDING");
    const backToOpen = await supportService.changeStatus(String(t1._id), admin, "OPEN");
    expect(backToOpen.status).toBe("OPEN");
    const resolved = await supportService.changeStatus(String(t1._id), admin, "RESOLVED");
    expect(resolved.status).toBe("RESOLVED");
    const closed = await supportService.changeStatus(String(t1._id), admin, "CLOSED");
    expect(closed.status).toBe("CLOSED");
    expect(closed.statusHistory.map((h) => h.resultingStatus)).toEqual([
      "OPEN",
      "PENDING",
      "OPEN",
      "RESOLVED",
      "CLOSED",
    ]);
  });

  it("disallowed transitions are rejected: OPEN->CLOSED, PENDING->CLOSED, RESOLVED->OPEN, RESOLVED->PENDING, CLOSED->anything", async () => {
    const admin = String(new Types.ObjectId());

    const openTicket = await makeTicket("open");
    await expect(
      supportService.changeStatus(String(openTicket._id), admin, "CLOSED"),
    ).rejects.toThrow();

    const pendingTicket = await makeTicket("pending");
    await supportService.changeStatus(String(pendingTicket._id), admin, "PENDING");
    await expect(
      supportService.changeStatus(String(pendingTicket._id), admin, "CLOSED"),
    ).rejects.toThrow();

    const resolvedTicket = await makeTicket("resolved");
    await supportService.changeStatus(String(resolvedTicket._id), admin, "RESOLVED");
    await expect(
      supportService.changeStatus(String(resolvedTicket._id), admin, "OPEN"),
    ).rejects.toThrow();
    await expect(
      supportService.changeStatus(String(resolvedTicket._id), admin, "PENDING"),
    ).rejects.toThrow();

    const closedTicket = await makeTicket("closed");
    await supportService.changeStatus(String(closedTicket._id), admin, "RESOLVED");
    await supportService.changeStatus(String(closedTicket._id), admin, "CLOSED");
    await expect(
      supportService.changeStatus(String(closedTicket._id), admin, "PENDING"),
    ).rejects.toThrow();
    await expect(
      supportService.changeStatus(String(closedTicket._id), admin, "OPEN"),
    ).rejects.toThrow();
  });

  it("a concurrent double status-change resolves exactly one winner (CAS)", async () => {
    const admin = String(new Types.ObjectId());
    const ticket = await makeTicket("race");

    const results = await Promise.allSettled([
      supportService.changeStatus(String(ticket._id), admin, "PENDING"),
      supportService.changeStatus(String(ticket._id), admin, "RESOLVED"),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const persisted = await supportTicketRepository.findById(ticket._id);
    expect(persisted?.statusHistory).toHaveLength(2); // CREATED + exactly one winning transition
  });

  it("Reopen succeeds from RESOLVED and from CLOSED, both back to OPEN, and is rejected from OPEN/PENDING", async () => {
    const admin = String(new Types.ObjectId());

    const fromResolved = await makeTicket("reopen-resolved");
    await supportService.changeStatus(String(fromResolved._id), admin, "RESOLVED");
    const reopened1 = await supportService.reopenAsAdmin(String(fromResolved._id), admin);
    expect(reopened1.status).toBe("OPEN");
    expect(reopened1.statusHistory.at(-1)?.action).toBe("REOPENED");

    const fromClosed = await makeTicket("reopen-closed");
    await supportService.changeStatus(String(fromClosed._id), admin, "RESOLVED");
    await supportService.changeStatus(String(fromClosed._id), admin, "CLOSED");
    const reopened2 = await supportService.reopenAsAdmin(String(fromClosed._id), admin);
    expect(reopened2.status).toBe("OPEN");

    const openTicket = await makeTicket("reopen-open-rejected");
    await expect(supportService.reopenAsAdmin(String(openTicket._id), admin)).rejects.toThrow();

    const pendingTicket = await makeTicket("reopen-pending-rejected");
    await supportService.changeStatus(String(pendingTicket._id), admin, "PENDING");
    await expect(supportService.reopenAsAdmin(String(pendingTicket._id), admin)).rejects.toThrow();
  });

  it("a requester can Reopen their own RESOLVED ticket and then reply again", async () => {
    const customer = await createCustomer("self-reopen");
    const admin = String(new Types.ObjectId());
    const ticket = await supportService.createTicket(String(customer._id), "CUSTOMER", {
      subject: "s",
      message: "m",
    });
    await supportService.changeStatus(String(ticket._id), admin, "RESOLVED");

    const reopened = await supportService.reopenOwnTicket(
      String(ticket._id),
      String(customer._id),
      "CUSTOMER",
    );
    expect(reopened.status).toBe("OPEN");

    const reply = await supportService.replyAsRequester(
      String(ticket._id),
      String(customer._id),
      "CUSTOMER",
      "one more thing",
    );
    expect(reply.message).toBe("one more thing");
  });

  // --- Booking linkage — server-verified, never trusted --------------------------------------------

  it("a Customer's own bookingId is verified and stored", async () => {
    const customer = await createCustomer("booking-own");
    const { booking } = await createBookingForCustomer(customer._id);

    const ticket = await supportService.createTicket(String(customer._id), "CUSTOMER", {
      subject: "About my booking",
      message: "Question",
      bookingId: String(booking._id),
    });
    expect(String(ticket.bookingId)).toBe(String(booking._id));
  });

  it("a Customer cannot link another Customer's bookingId (cross-customer rejected)", async () => {
    const owner = await createCustomer("booking-real-owner");
    const stranger = await createCustomer("booking-stranger");
    const { booking } = await createBookingForCustomer(owner._id);

    await expect(
      supportService.createTicket(String(stranger._id), "CUSTOMER", {
        subject: "s",
        message: "m",
        bookingId: String(booking._id),
      }),
    ).rejects.toThrow();
  });

  it("a Business Owner can link a bookingId that belongs to their OWN Business", async () => {
    const customer = await createCustomer("booking-biz-customer");
    const { owner, booking } = await createBookingForCustomer(customer._id);

    const ticket = await supportService.createTicket(String(owner._id), "BUSINESS_OWNER", {
      subject: "About this booking",
      message: "Question",
      bookingId: String(booking._id),
    });
    expect(String(ticket.bookingId)).toBe(String(booking._id));
  });

  it("a Business Owner cannot link a bookingId belonging to ANOTHER Business (cross-business rejected)", async () => {
    const customer = await createCustomer("booking-cross-biz-customer");
    const { booking } = await createBookingForCustomer(customer._id);
    const { owner: unrelatedOwner } = await createBusiness("Unrelated Biz");

    await expect(
      supportService.createTicket(String(unrelatedOwner._id), "BUSINESS_OWNER", {
        subject: "s",
        message: "m",
        bookingId: String(booking._id),
      }),
    ).rejects.toThrow();
  });

  it("an invalid bookingId format is rejected before any lookup", async () => {
    const customer = await createCustomer("booking-invalid");
    await expect(
      supportService.createTicket(String(customer._id), "CUSTOMER", {
        subject: "s",
        message: "m",
        bookingId: "not-a-real-object-id",
      }),
    ).rejects.toThrow();
  });

  // --- Email best-effort ---------------------------------------------------------------------------

  it("a ticket-created email failure never fails ticket creation", async () => {
    emailProvider.shouldFail = true;
    const customer = await createCustomer("email-fail");
    const ticket = await supportService.createTicket(String(customer._id), "CUSTOMER", {
      subject: "s",
      message: "m",
    });
    expect(ticket.status).toBe("OPEN");
    expect(emailProvider.sent).toHaveLength(0);
  });

  it("a successful ticket-created email is sent to the requester's own address with the reference", async () => {
    const customer = await createCustomer("email-ok");
    const ticket = await supportService.createTicket(String(customer._id), "CUSTOMER", {
      subject: "s",
      message: "m",
    });
    expect(emailProvider.sent).toHaveLength(1);
    expect(emailProvider.sent[0]?.to).toBe(customer.normalizedEmail);
    expect(emailProvider.sent[0]?.text).toContain(ticket.reference);
  });

  it("an admin-reply email failure never fails the reply itself", async () => {
    const customer = await createCustomer("email-reply-fail");
    const ticket = await supportService.createTicket(String(customer._id), "CUSTOMER", {
      subject: "s",
      message: "m",
    });
    emailProvider.shouldFail = true;
    const reply = await supportService.replyAsAdmin(
      String(ticket._id),
      String(new Types.ObjectId()),
      "we're looking into it",
    );
    expect(reply.message).toBe("we're looking into it");
  });

  // --- No delete path --------------------------------------------------------------------------

  it("SupportService exposes no delete method for a Ticket or a Message", () => {
    expect((supportService as unknown as { deleteTicket?: unknown }).deleteTicket).toBeUndefined();
    expect((supportService as unknown as { delete?: unknown }).delete).toBeUndefined();
    expect(
      (supportService as unknown as { deleteMessage?: unknown }).deleteMessage,
    ).toBeUndefined();
  });

  // --- helper --------------------------------------------------------------------------------

  async function makeTicket(tag: string) {
    const customer = await createCustomer(tag);
    return supportService.createTicket(String(customer._id), "CUSTOMER", {
      subject: `subject-${tag}`,
      message: `message-${tag}`,
    });
  }
});
