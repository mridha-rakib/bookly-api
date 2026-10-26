/** Test-only retained/accepted synthetic offers. Real JWT/session/CAS and final scheduling;
 * authority module mocking belongs exclusively to the importing Vitest file. */
import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { vi } from "vitest";
import { AddonModel } from "../../src/modules/addons/addon.model.js";
import { AddonRepository } from "../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentModel } from "../../src/modules/addons/addon-service-assignment.model.js";
import { AddonServiceAssignmentRepository } from "../../src/modules/addons/addon-service-assignment.repository.js";
import { TokenService } from "../../src/modules/auth/token.service.js";
import { AvailabilityService } from "../../src/modules/availability/availability.service.js";
import { BookingRepository } from "../../src/modules/booking/booking.repository.js";
import { BookingService } from "../../src/modules/booking/booking.service.js";
import { BookingCreationClaimRepository } from "../../src/modules/booking/booking-creation-claim.repository.js";
import { BookingLifecycleService } from "../../src/modules/booking/booking-lifecycle.service.js";
import { PackageBatchPersistence } from "../../src/modules/booking/package-batch-persistence.js";
import { PackageCheckoutAcceptanceService } from "../../src/modules/booking/package-checkout-acceptance.service.js";
import { PackageCheckoutCustomerAuthority } from "../../src/modules/booking/package-checkout-customer-authority.js";
import { PackageCheckoutQuotePreparer } from "../../src/modules/booking/package-checkout-quote.service.js";
import { BookingFinancialTransactionRepository } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { BookingSlotReservationRepository } from "../../src/modules/booking-slot-reservation/booking-slot-reservation.repository.js";
import { BookingSlotReservationService } from "../../src/modules/booking-slot-reservation/booking-slot-reservation.service.js";
import { BusinessRepository } from "../../src/modules/business/business.repository.js";
import { BusinessBookingSettingsRepository } from "../../src/modules/business-booking-settings/business-booking-settings.repository.js";
import { cancellationTiers } from "../../src/modules/business-cancellation-policy/business-cancellation-policy.model.js";
import { BusinessCancellationPolicyRepository } from "../../src/modules/business-cancellation-policy/business-cancellation-policy.repository.js";
import { BusinessHoursRepository } from "../../src/modules/business-hours/business-hours.repository.js";
import { BusinessTravelSettingsRepository } from "../../src/modules/business-travel-settings/business-travel-settings.repository.js";
import { ClientRepository } from "../../src/modules/client/client.repository.js";
import { CustomerPaymentProfileRepository } from "../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../src/modules/payment/payment.service.js";
import { SessionRepository } from "../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../src/modules/staff/staff.repository.js";
import { StaffScheduleRepository } from "../../src/modules/staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../../src/modules/staff/staff-time-off.repository.js";
import { UserModel, UserProfileModel } from "../../src/modules/user/user.model.js";
import { UserRepository } from "../../src/modules/user/user.repository.js";
import { issueTestAccessToken } from "./access-token.js";
import { FakePaymentGateway } from "./fake-payment-gateway.js";
import { checkoutFixture } from "./package-checkout-fixture.js";

export const INTERNAL_TIME = new Date("2030-08-19T08:01:00Z");
export async function packageBatchFixture(
  options: {
    count?: number;
    group?: boolean;
    mode?: "FINITE" | "FOREVER";
    months?: 6 | 12;
    manual?: boolean;
    tie?: boolean;
    reverse?: boolean;
    travel?: boolean;
    extraTravelCity?: boolean;
    first?: boolean;
    categoryWindow?: boolean;
    addon?: boolean;
    bundlePriceCents?: number;
    policy?: boolean;
    latePercentage?: number;
    penaltyBasisCents?: number;
    endReminder?: boolean;
  } = {},
) {
  const f = checkoutFixture(options.mode ?? "FOREVER", 4);
  const count = options.count ?? 2;
  f.business.set({
    ownerName: "Owner",
    email: "owner@f1.test",
    phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
    briefDescription: "Internal F1 synthetic",
    category: "Historical custom category",
    categoryKey: undefined,
    timezone: "UTC",
  });
  if (options.travel) f.business.set("visitType", "TRAVEL_TO_CUSTOMER");
  if (options.categoryWindow)
    f.business.set({ category: "Wellness & Beauty", categoryKey: "BEAUTY_WELLNESS" });
  await f.business.save();
  for (const p of f.providers) {
    await p.save();
    await UserProfileModel.create({
      userId: p.userId,
      firstName: "Provider",
      lastName: p._id.toHexString(),
      gender: "other",
    });
  }
  for (const s of f.services) {
    s.set({
      category: f.business.category,
      subcategory: "F1",
      serviceCategoryId: new Types.ObjectId(),
      sessionExpiryAlert: { enabled: false },
      fixedPricing: {
        priceCents: 9000,
        durationMin: 60,
        bookingIntervalMin: 5,
        processingTimeMin: 15,
        bufferAfterMin: 10,
      },
    });
  }
  if (options.group)
    f.services[0]?.set({
      pricingMode: "PER_PERSON",
      fixedPricing: undefined,
      perPersonPricing: {
        ratePerPersonCents: 9000,
        minPersons: 1,
        maxPersons: 3,
        durationMin: 60,
        bookingIntervalMin: 5,
        bufferAfterMin: 25,
      },
    });
  for (const s of f.services) {
    if (options.extraTravelCity)
      s.set("servedCities", [...new Set([...s.servedCities, "Nicosia"])]);
    if (options.manual)
      s.set({
        scheduleMode: "MANUAL",
        manualSchedule: [{ dayOfWeek: "TUESDAY", isOpen: true, times: ["19:00", "21:00"] }],
      });
    if (options.endReminder)
      s.set("sessionExpiryAlert", { enabled: true, minutesBeforeSessionEnds: 10 });
    await s.save();
  }
  f.definition.set({
    category: f.business.category,
    subcategory: "F1",
    serviceCategoryId: new Types.ObjectId(),
  });
  for (const item of f.definition.items)
    item.penaltyBasisCents = options.policy ? (options.penaltyBasisCents ?? 1000) : 0;
  if (options.mode === "FINITE")
    f.definition.set("contractTerms.validity.months", options.months ?? 6);
  if (options.bundlePriceCents !== undefined)
    f.definition.set("bundlePriceCents", options.bundlePriceCents);
  await f.definition.save();
  f.client.set({
    createdByUserId: f.business.ownerUserId,
    firstName: "Buyer",
    normalizedEmail: "buyer@f1.test",
    phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
    linkState: "LINKED",
  });
  await f.client.save();
  const businesses = new BusinessRepository(),
    staff = new StaffRepository(),
    services = new (
      await import("../../src/modules/services/service.repository.js")
    ).ServiceRepository();
  const schedules = new StaffScheduleRepository(),
    hours = new BusinessHoursRepository(),
    travel = new BusinessTravelSettingsRepository();
  if (options.travel)
    await travel.upsertByBusinessId(f.business._id, [
      { city: "Larnaca", active: true, feeCents: 300 },
      ...(options.extraTravelCity
        ? [{ city: "Nicosia" as const, active: true, feeCents: 700 }]
        : []),
    ]);
  const days = [
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ] as const;
  for (const p of f.providers)
    await schedules.replace(
      p._id,
      f.business._id,
      days.map((dayOfWeek) => ({
        dayOfWeek,
        intervals: [{ startTime: "00:00", endTime: "23:59" }],
      })),
    );
  await hours.replace(
    f.business._id,
    days.map((dayOfWeek) => ({
      dayOfWeek,
      isOpen: true,
      slots: [{ startTime: "09:00", endTime: "18:00" }],
    })),
  );
  const reservations = new BookingSlotReservationService(new BookingSlotReservationRepository());
  const availability = new AvailabilityService(
    businesses,
    services,
    staff,
    schedules,
    new StaffTimeOffRepository(),
    hours,
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
    new ClientRepository(),
    new BookingRepository(),
  );
  const addonId = new Types.ObjectId();
  if (options.addon) {
    await AddonModel.create({
      _id: addonId,
      businessId: f.business._id,
      status: "ACTIVE",
      name: "Accepted extra",
      priceCents: 500,
    });
    for (const s of f.services)
      await AddonServiceAssignmentModel.create({
        businessId: f.business._id,
        addonId,
        serviceId: s._id,
      });
  }
  const policyRepo = new BusinessCancellationPolicyRepository();
  if (options.policy)
    await policyRepo.replace(
      f.business._id,
      cancellationTiers.map((tier) =>
        options.latePercentage === undefined
          ? { tier, mode: "FREE" as const }
          : { tier, mode: "PERCENTAGE" as const, percentage: options.latePercentage },
      ),
      20,
    );
  const original = f.intent.selections;
  const indices = count === 3 ? [0, 1, 3] : [0, 3];
  if (options.reverse) indices.reverse();
  const intent = {
    ...f.intent,
    selections: indices.map((index, n) => {
      const selection = original[index];
      if (!selection) throw new Error("Missing synthetic selection");
      return {
        ...selection,
        addonIds: options.addon ? [addonId] : [],
        ...(options.travel
          ? {
              travelAddress: {
                city: "Larnaca" as const,
                area: "Center",
                streetName: "Main",
                streetNumber: "9",
                propertyType: "House" as const,
              },
            }
          : {}),
        startAt: new Date(
          `2030-08-20T${options.manual ? (n === 0 ? "19" : "21") : options.tie ? "09" : String(9 + (options.reverse ? indices.length - 1 - n : n) * 2).padStart(2, "0")}:00:00Z`,
        ),
        staffMembershipId:
          options.tie && n === 1 ? f.providers[1]?._id : selection.staffMembershipId,
      };
    }),
  };
  if (intent.selections.some((s) => !s.staffMembershipId)) throw new Error("Missing provider");
  const seed = {
    ...f.seed,
    issuedAt: new Date("2030-08-19T08:00:00Z"),
    expiresAt: new Date("2030-08-19T08:30:00Z"),
    appointments: indices.map((index) => {
      const row = f.seed.appointments[index];
      if (!row) throw new Error("Missing identity");
      return row;
    }),
  };
  const deps = {
    ...f.dependencies,
    availability,
    booking,
    travel,
    relationships: {
      peekClassification: vi.fn(() =>
        options.first ? ("FIRST" as const) : ("RETURNING" as const),
      ),
    },
    policies: options.policy ? policyRepo : { findByBusinessId: vi.fn(async () => null) },
  };
  let now = INTERNAL_TIME;
  const preparer = new PackageCheckoutQuotePreparer(deps, () => now);
  const quote = await preparer.prepare(f.context, intent, seed);
  const claims = new BookingCreationClaimRepository();
  const retention = await claims.retainPackageCheckout({
    version: 1,
    state: "INTERNAL_RETAINED_NOT_ACCEPTED",
    seed,
    intent,
    quote,
  });
  await UserModel.create({
    _id: f.context.customerUserId,
    normalizedEmail: "customer@f1.test",
    passwordHash: "unused",
    role: "CUSTOMER",
    status: "ACTIVE",
    security: { passwordUpdatedAt: new Date() },
  });
  const users = new UserRepository(),
    tokens = new TokenService(new SessionRepository());
  const authority = new PackageCheckoutCustomerAuthority(tokens, users, () => now);
  const acceptance = new PackageCheckoutAcceptanceService(
    claims,
    authority,
    preparer,
    staff,
    users,
    () => now,
  );
  const authorization = `Bearer ${await issueTestAccessToken(tokens, { userId: f.context.customerUserId, role: "CUSTOMER" })}`;
  const presentation = await acceptance.present(authorization, f.business._id, seed.idempotencyKey);
  await acceptance.accept(authorization, f.business._id, seed.idempotencyKey, {
    version: 1,
    action: "ACCEPT_PACKAGE_CHECKOUT_TERMS",
    eventId: randomUUID(),
    presentationId: presentation.presentationId,
    challenge: presentation.challenge,
    templateVersion: 1,
    quoteHash: presentation.disclosure.content.quoteHash,
    disclosureHash: presentation.disclosure.contentHash,
  });
  const scope = {
    customer: await authority.authenticate(authorization),
    businessId: f.business._id,
    businessClientId: f.client._id,
    idempotencyKey: seed.idempotencyKey,
  };
  const writer = new PackageBatchPersistence(availability, reservations, () => now);
  const another = async (shiftAll = false, staggerFixed = false) => {
    const nextIntent = {
      ...intent,
      selections: intent.selections.map((s) => ({
        ...s,
        startAt: new Date(
          s.startAt.getTime() +
            (shiftAll
              ? 86400000
              : staggerFixed && !s.serviceId.equals(f.services[0]?._id)
                ? 4 * 3600000
                : 0),
        ),
      })),
    };
    const nextSeed = {
      ...seed,
      idempotencyKey: `f1:${new Types.ObjectId()}`,
      quoteId: new Types.ObjectId(),
      batchId: new Types.ObjectId(),
      packageProgressId: new Types.ObjectId(),
      temporalProofRef: new Types.ObjectId(),
      items: seed.items.map((i) => ({ ...i, packageItemId: new Types.ObjectId() })),
      appointments: seed.appointments.map((a) => ({ ...a, bookingId: new Types.ObjectId() })),
    };
    const nextQuote = await preparer.prepare(f.context, nextIntent, nextSeed);
    await claims.retainPackageCheckout({
      version: 1,
      state: "INTERNAL_RETAINED_NOT_ACCEPTED",
      seed: nextSeed,
      intent: nextIntent,
      quote: nextQuote,
    });
    const presented = await acceptance.present(
      authorization,
      f.business._id,
      nextSeed.idempotencyKey,
    );
    await acceptance.accept(authorization, f.business._id, nextSeed.idempotencyKey, {
      version: 1,
      action: "ACCEPT_PACKAGE_CHECKOUT_TERMS",
      eventId: randomUUID(),
      presentationId: presented.presentationId,
      challenge: presented.challenge,
      templateVersion: 1,
      quoteHash: presented.disclosure.content.quoteHash,
      disclosureHash: presented.disclosure.contentHash,
    });
    return {
      quote: nextQuote,
      scope: {
        ...scope,
        customer: await authority.authenticate(authorization),
        idempotencyKey: nextSeed.idempotencyKey,
      },
    };
  };
  const lifecycle = new BookingLifecycleService(
    booking,
    new BookingRepository(),
    businesses,
    reservations,
    availability,
    services,
    staff,
    new PaymentService(new FakePaymentGateway(), new CustomerPaymentProfileRepository(), users),
    new BookingFinancialTransactionService(new BookingFinancialTransactionRepository()),
  );
  return {
    f,
    quote,
    retention,
    scope,
    writer,
    authority,
    tokens,
    authorization,
    schedules,
    hours,
    services,
    lifecycle,
    booking,
    reservations,
    availability,
    another,
    advance: (at: Date) => {
      now = at;
    },
  };
}
