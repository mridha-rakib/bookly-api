import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import { AvailabilityService } from "../../../src/modules/availability/availability.service.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { BookingService } from "../../../src/modules/booking/booking.service.js";
import { BookingCreationClaimModel } from "../../../src/modules/booking/booking-creation-claim.model.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import { packageReservationPartySize } from "../../../src/modules/booking/booking-package-foundation.js";
import {
  acquireSchedulingAdmission,
  validateSchedulingLine,
  verifiedOccupiedMilliseconds,
} from "../../../src/modules/booking/booking-scheduling-admission.js";
import { PackageCheckoutQuotePreparer } from "../../../src/modules/booking/package-checkout-quote.service.js";
import { BookingSlotReservationModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.model.js";
import { BookingSlotReservationRepository } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.repository.js";
import { BookingSlotReservationService } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.service.js";
import { BookingSlotReservationClaimModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation-claim.model.js";
import { packageInitialReservationKey } from "../../../src/modules/booking-slot-reservation/reservation-operation.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessBookingSettingsRepository } from "../../../src/modules/business-booking-settings/business-booking-settings.repository.js";
import { BusinessCancellationPolicyRepository } from "../../../src/modules/business-cancellation-policy/business-cancellation-policy.repository.js";
import { BusinessHoursRepository } from "../../../src/modules/business-hours/business-hours.repository.js";
import { BusinessTravelSettingsRepository } from "../../../src/modules/business-travel-settings/business-travel-settings.repository.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { FinancialRelationshipService } from "../../../src/modules/client/financial-relationship.service.js";
import { buildPurchasedPackage } from "../../../src/modules/package-progress/build-purchased-package.js";
import { PackageProgressV2Model } from "../../../src/modules/package-progress/package-progress-v2.model.js";
import { PackageProgressV2Repository } from "../../../src/modules/package-progress/package-progress-v2.repository.js";
import { derivePackageProgressV2Totals } from "../../../src/modules/package-progress/package-progress-v2.rules.js";
import { PackageRepository } from "../../../src/modules/packages/package.repository.js";
import { PackageService } from "../../../src/modules/packages/package.service.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { ServiceCategoryRepository } from "../../../src/modules/services/service-category.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../../../src/modules/staff/staff-time-off.repository.js";
import { packageV2Fixture, serviceFields, transaction } from "../../helpers/package-v2-fixture.js";
import { BEFORE, prospectiveFixture } from "../../helpers/package-v2-prospective-fixture.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/** Internal synthetic entitlement/admission fixtures only. No purchase route or producer. */
describe("D1-G Group Package contract on owned MongoDB", () => {
  beforeAll(connectIsolatedDatabase, 120000);
  beforeEach(clearIsolatedDatabase);
  afterAll(stopIsolatedReplicaSet);
  const services = new ServiceRepository(),
    businesses = new BusinessRepository(),
    staff = new StaffRepository();
  const travel = new BusinessTravelSettingsRepository(),
    hours = new BusinessHoursRepository(),
    shifts = new StaffScheduleRepository();
  const reservations = new BookingSlotReservationService(new BookingSlotReservationRepository());
  const availability = new AvailabilityService(
    businesses,
    services,
    staff,
    shifts,
    new StaffTimeOffRepository(),
    hours,
    new BusinessBookingSettingsRepository(),
    travel,
    new BookingSlotReservationRepository(),
  );
  const packages = new PackageRepository(),
    categories = new ServiceCategoryRepository();
  const definitions = new PackageService(packages, businesses, services, categories, staff, travel);
  const bookingReads = new BookingService(
    businesses,
    staff,
    services,
    new AddonRepository(),
    new AddonServiceAssignmentRepository(),
    new ClientRepository(),
    new BookingRepository(),
  );
  const seat = {
    version: 1 as const,
    unit: "ONE_SEAT" as const,
    credits: 1 as const,
    partySize: 1 as const,
    capacityMax: 3,
  };
  const startAt = new Date("2030-08-20T09:00:00Z"),
    endAt = new Date("2030-08-20T10:15:00Z");
  const location = {
    city: "Larnaca" as const,
    area: "Center",
    streetName: "Main",
    streetNumber: "1",
  };
  async function fixture() {
    const f = await packageV2Fixture([3, 2], false);
    const old = f.services[0];
    if (!old) throw new Error("Missing fixture Service");
    const service = await services.replaceById(f.business._id, old._id, {
      ...serviceFields(old),
      pricingMode: "PER_PERSON",
      fixedPricing: undefined,
      perPersonPricing: {
        ratePerPersonCents: 9000,
        minPersons: 1,
        maxPersons: 3,
        durationMin: 60,
        bufferAfterMin: 15,
      },
    });
    if (!service) throw new Error("Missing changed Service");
    f.definition.set("contractTerms", {
      version: 2,
      validity: { mode: "FOREVER" },
      penaltyPolicyVersion: 1,
    });
    f.definition.items.forEach((item) => {
      item.penaltyBasisCents = 5000;
    });
    await f.definition.save();
    const input = prospectiveFixture(
      buildPurchasedPackage({
        definition: f.definition,
        business: f.business,
        services: [service, ...f.services.slice(1)],
        customerUserId: f.customerId,
        businessClientId: f.client._id,
        originBookingId: f.input.originBookingId,
        firstItemId: f.definition.items[0]?.itemId ?? new Types.ObjectId(),
        packageProgressId: f.input._id,
      }),
      "FOREVER",
    );
    await shifts.replace(f.provider._id, f.business._id, [
      { dayOfWeek: "TUESDAY", intervals: [{ startTime: "00:00", endTime: "23:59" }] },
    ]);
    await hours.replace(f.business._id, [
      { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "00:00", endTime: "23:59" }] },
    ]);
    const context = {
      businessId: f.business._id,
      customerUserId: f.customerId,
      actorUserId: f.customerId,
      role: "CUSTOMER" as const,
    };
    const selectionId = new Types.ObjectId();
    const intent = {
      packageId: f.definition._id,
      expectedRevision: 1,
      selections: [
        {
          selectionId,
          definitionItemId: f.definition.items[0]?.itemId,
          serviceId: service._id,
          staffMembershipId: f.provider._id,
          startAt,
          addonIds: [],
        },
      ],
    };
    const seed = {
      version: 1,
      quoteId: new Types.ObjectId(),
      batchId: new Types.ObjectId(),
      packageProgressId: input._id,
      idempotencyKey: `group:${new Types.ObjectId()}`,
      issuedAt: new Date("2030-08-19T08:00:00Z"),
      expiresAt: new Date("2030-08-19T08:30:00Z"),
      ...context,
      actorRole: "CUSTOMER",
      items: input.items.map((item) => ({
        definitionItemId: item.definitionItemId,
        packageItemId: item.packageItemId,
      })),
      appointments: [{ selectionId, bookingId: input.originBookingId }],
    };
    const { role: _role, ...seedWithoutRole } = seed;
    const preparer = new PackageCheckoutQuotePreparer(
      {
        businesses,
        packages,
        services,
        staff,
        clients: new ClientRepository(),
        relationships: {
          peekClassification: FinancialRelationshipService.prototype.peekClassification,
        },
        booking: bookingReads,
        availability,
        travel,
        policies: new BusinessCancellationPolicyRepository(),
        cards: { getSavedCardStatus: async () => ({ hasSavedCard: true }) },
        readNoShowWindows: async () => [],
      },
      () => new Date("2030-08-19T08:01:00Z"),
    );
    return {
      ...f,
      service,
      input,
      context,
      intent,
      seed: seedWithoutRole,
      prepare: () => preparer.prepare(context, intent, seedWithoutRole),
    };
  }
  const slot = (f: Awaited<ReturnType<typeof fixture>>, key: string) => ({
    businessId: f.business._id,
    staffMembershipId: f.provider._id,
    serviceId: f.service._id,
    timezone: f.business.timezone,
    startAt,
    endAt,
    capacityMax: 3,
    partySize: 1,
    idempotencyKey: key,
  });
  it("prepares a real available Group interval, retains exact evidence, and rejects it when full", async () => {
    const f = await fixture();
    await reservations.reserveOrJoin(slot(f, "ordinary-creator"));
    const q = await f.prepare();
    expect(q.payload.appointments[0]?.group).toEqual(seat);
    expect(q.payload.appointments[0]?.endAt).toEqual(endAt);
    expect(q.payload.financials.normalTotalCents).toBe(100);
    const claims = new BookingCreationClaimRepository();
    await claims.retainPackageCheckout({
      version: 1,
      state: "INTERNAL_RETAINED_NOT_ACCEPTED",
      seed: f.seed,
      intent: f.intent,
      quote: q,
    });
    const original = await BookingCreationClaimModel.findOne({
      idempotencyKey: f.seed.idempotencyKey,
    }).orFail();
    original.set("packageCheckoutRetention.quote.payload.appointments.0.group.partySize", 2);
    await expect(original.save({ validateBeforeSave: false })).rejects.toThrow();
    await expect(
      BookingCreationClaimModel.updateOne(
        { _id: original._id },
        { $set: { "packageCheckoutRetention.quote.payload.appointments.0.group.capacityMax": 99 } },
      ),
    ).rejects.toThrow();
    await reservations.reserveOrJoin(slot(f, "other-party"));
    await reservations.reserveOrJoin(slot(f, "final-party"));
    await expect(f.prepare()).rejects.toThrow("no longer available");
  });
  it("persists prospective mixed Group/FIXED quantities and claims one Group credit", async () => {
    const f = await fixture();
    const repo = new PackageProgressV2Repository(() => BEFORE);
    await transaction((session) => repo.create(f.input, session));
    const progress = await PackageProgressV2Model.findById(f.input._id).orFail();
    expect(progress.items[0]?.serviceSnapshot).toMatchObject({
      pricingMode: "PER_PERSON",
      group: seat,
    });
    expect(derivePackageProgressV2Totals(progress.toObject())).toMatchObject({
      totalSessions: 5,
      remainingSessions: 4,
      scheduledSessions: 1,
    });
    // Valid model fixture for existing balance authority; not a genuine purchased Booking.
    await BookingModel.create({
      _id: f.input.originBookingId,
      businessId: f.business._id,
      reference: `GROUP-${new Types.ObjectId()}`,
      source: "BOOKLY_MANAGED",
      status: "UPCOMING",
      customer: {
        businessClientId: f.client._id,
        customerUserId: f.customerId,
        contact: {
          firstName: "Synthetic",
          normalizedEmail: "synthetic@example.com",
          phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
        },
      },
      createdBy: { actorUserId: f.customerId, actorRole: "CUSTOMER" },
      fulfilment: { mode: "AT_BUSINESS_LOCATION", businessLocation: location },
      schedule: { timezone: f.business.timezone, startAt, endAt },
      financials: {
        currency: "EUR",
        servicesSubtotalCents: 0,
        addonsSubtotalCents: 0,
        serviceDiscountCents: 0,
        travelFeeCents: 0,
        eligiblePlatformFeeBasisCents: 0,
        platformFeeCents: 0,
        depositCents: 0,
        balanceDueCents: 0,
        totalCents: 0,
      },
      serviceLines: [
        {
          serviceId: f.service._id,
          responsibleStaffMembershipId: f.provider._id,
          serviceSnapshot: { name: "Group", pricingMode: "PACKAGE", durationMin: 60 },
          pricingInput: {
            packageProgressId: f.input._id,
            packageItemId: f.input.items[0]?.packageItemId,
          },
          packageContext: {
            packageId: f.definition._id,
            packageName: "Bundle",
            definitionItemId: f.definition.items[0]?.itemId ?? new Types.ObjectId(),
            role: "PURCHASE",
          },
          schedulingSnapshot: {
            version: 1,
            baseDurationMin: 60,
            processingTimeMin: 0,
            bufferAfterMin: 15,
            occupiedDurationMin: 75,
            group: seat,
          },
          amountCents: 0,
          reservationId: new Types.ObjectId(),
          addons: [],
        },
      ],
    });
    const bookingId = new Types.ObjectId();
    const scope = {
      packageProgressId: f.input._id,
      businessId: f.business._id,
      customerUserId: f.customerId,
      packageItemId: f.input.items[0]?.packageItemId ?? new Types.ObjectId(),
      serviceId: f.service._id,
    };
    await transaction((session) => repo.claim(scope, bookingId, session));
    await transaction((session) => repo.claim(scope, bookingId, session));
    const after = await PackageProgressV2Model.findById(f.input._id).orFail();
    expect(after.items[0]?.remainingSessions).toBe(1);
    expect(after.sessions.filter((row) => row.bookingId.equals(bookingId))).toHaveLength(1);
  });
  it.each(["capacity", "mode", "provider", "archive"])(
    "protects outstanding Group %s dependency",
    async (kind) => {
      const f = await fixture();
      await transaction((session) => new PackageProgressV2Repository().create(f.input, session));
      if (kind === "provider") {
        await expect(staff.softRemoveById(f.business._id, f.provider._id)).rejects.toMatchObject({
          statusCode: 409,
        });
        return;
      }
      if (kind === "archive") {
        await expect(services.archiveById(f.business._id, f.service._id)).rejects.toMatchObject({
          statusCode: 409,
        });
        return;
      }
      const fields = serviceFields(f.service);
      if (kind === "capacity")
        fields.perPersonPricing = {
          ...f.service.perPersonPricing,
          ratePerPersonCents: 9000,
          minPersons: 1,
          maxPersons: 4,
          durationMin: 60,
        };
      else {
        fields.pricingMode = "FIXED";
        fields.perPersonPricing = undefined;
        fields.fixedPricing = { priceCents: 100, durationMin: 60 };
      }
      await expect(
        services.replaceById(f.business._id, f.service._id, fields),
      ).rejects.toMatchObject({ statusCode: 409 });
    },
  );
  it("joins, replays and releases one Package seat through actual C1/B2/B3", async () => {
    const f = await fixture();
    const original = await reservations.reserveOrJoin(slot(f, "ordinary"));
    const packageOperation = {
      version: 1 as const,
      kind: "PACKAGE_INITIAL_APPOINTMENT" as const,
      businessId: String(f.business._id),
      bookingId: String(f.input.originBookingId),
      batchId: String(f.seed.batchId),
      selectionId: String(f.intent.selections[0]?.selectionId),
    };
    const input = { ...slot(f, packageInitialReservationKey(packageOperation)), packageOperation };
    const joined = await transaction(async (session) => {
      const current = await acquireSchedulingAdmission(f.business, session);
      await validateSchedulingLine(
        {
          business: current,
          serviceId: f.service._id,
          staffMembershipId: f.provider._id,
          startAt,
          endAt,
          partySize: 1,
          capacityMax: 3,
          packageGroup: seat,
          allowInactive: false,
          fulfilment: { mode: "AT_BUSINESS_LOCATION", businessLocation: location },
        },
        availability,
        session,
      );
      return reservations.reserveOrJoin(input, session);
    });
    expect(String(joined.reservationId)).toBe(String(original.reservationId));
    await reservations.reserveOrJoin(input);
    const claim = await BookingSlotReservationClaimModel.findOne({
      idempotencyKey: input.idempotencyKey,
    }).orFail();
    expect(claim.effect).toMatchObject({ role: "JOINER", state: "APPLIED" });
    expect(String(claim.reservationId)).not.toBe(String(joined.reservationId));
    expect((await BookingSlotReservationModel.findOne().orFail()).intervals[0]?.capacityUsed).toBe(
      2,
    );
    expect(await reservations.release({ ...input, reservationId: joined.reservationId })).toEqual({
      released: true,
      alreadyReleased: false,
    });
    expect(await reservations.release({ ...input, reservationId: joined.reservationId })).toEqual({
      released: false,
      alreadyReleased: true,
    });
    expect((await BookingSlotReservationModel.findOne().orFail()).intervals[0]?.capacityUsed).toBe(
      1,
    );
  });
  it("refuses a multi-seat initial Package operation before writing occupancy", async () => {
    const f = await fixture();
    const packageOperation = {
      version: 1 as const,
      kind: "PACKAGE_INITIAL_APPOINTMENT" as const,
      businessId: String(f.business._id),
      bookingId: String(f.input.originBookingId),
      batchId: String(f.seed.batchId),
      selectionId: String(f.intent.selections[0]?.selectionId),
    };
    await expect(
      reservations.reserveOrJoin({
        ...slot(f, packageInitialReservationKey(packageOperation)),
        packageOperation,
        partySize: 2,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(0);
    expect(await BookingSlotReservationModel.countDocuments()).toBe(0);
  });
  it("publishes and updates a supported Group definition with unchanged bundle economics", async () => {
    const f = await fixture();
    const category = await categories.create({
      businessId: f.business._id,
      name: "Group",
      nameKey: "group",
    });
    const body = {
      name: "Group3",
      status: "ACTIVE" as const,
      isFeatured: false,
      serviceCategoryId: String(category._id),
      subcategory: "Massage",
      bundlePriceCents: 100,
      contractTerms: { validity: { mode: "FOREVER" as const } },
      items: [
        {
          serviceId: String(f.service._id),
          includedSessions: 3,
          referenceUnitPriceCents: 100,
          penaltyBasisCents: 5000,
        },
      ],
    };
    const result = await definitions.create(String(f.ownerId), String(f.business._id), body);
    expect(result).toMatchObject({ sellable: true, newContractReady: true, bundlePriceCents: 100 });
    const updated = await definitions.update(String(f.ownerId), String(f.business._id), result.id, {
      ...body,
      expectedRevision: result.revision,
      name: "Group3 updated",
    });
    expect(updated.sellable).toBe(true);
    await expect(
      definitions.create(String(f.ownerId), String(new Types.ObjectId()), body),
    ).rejects.toThrow();
  });
  it.each(["foreign", "unsupported"])(
    "rejects %s Group definition sources on actual persistence reads",
    async (kind) => {
      const f = await fixture();
      const category = await categories.create({
        businessId: f.business._id,
        name: "Groups",
        nameKey: "groups",
      });
      let serviceId = f.service._id;
      if (kind === "foreign") serviceId = (await fixture()).service._id;
      else
        await services.replaceById(f.business._id, f.service._id, {
          ...serviceFields(f.service),
          perPersonPricing: {
            ratePerPersonCents: 9000,
            minPersons: 2,
            maxPersons: 3,
            durationMin: 60,
          },
        });
      await expect(
        definitions.create(String(f.ownerId), String(f.business._id), {
          name: "Invalid Group",
          status: "ACTIVE",
          isFeatured: false,
          serviceCategoryId: String(category._id),
          subcategory: "Massage",
          bundlePriceCents: 100,
          items: [
            {
              serviceId: String(serviceId),
              includedSessions: 3,
              referenceUnitPriceCents: 100,
              penaltyBasisCents: 5000,
            },
          ],
        }),
      ).rejects.toThrow();
    },
  );
  it("moves a synthetic Package line with one seat and independently verified frozen duration, atomically", async () => {
    const f = await fixture();
    const creator = await reservations.reserveOrJoin(slot(f, "old-other-customer"));
    const oldInput = slot(f, "synthetic-package-party");
    const joined = await reservations.reserveOrJoin(oldInput);
    expect(String(joined.reservationId)).toBe(String(creator.reservationId));
    const booking = await BookingModel.create({
      _id: f.input.originBookingId,
      businessId: f.business._id,
      reference: `GROUP-${new Types.ObjectId()}`,
      source: "BOOKLY_MANAGED",
      status: "UPCOMING",
      customer: {
        businessClientId: f.client._id,
        customerUserId: f.customerId,
        contact: {
          firstName: "Synthetic",
          normalizedEmail: "synthetic@example.com",
          phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
        },
      },
      createdBy: { actorUserId: f.customerId, actorRole: "CUSTOMER" },
      fulfilment: { mode: "AT_BUSINESS_LOCATION", businessLocation: location },
      schedule: { timezone: f.business.timezone, startAt, endAt },
      financials: {
        currency: "EUR",
        servicesSubtotalCents: 0,
        addonsSubtotalCents: 0,
        serviceDiscountCents: 0,
        travelFeeCents: 0,
        eligiblePlatformFeeBasisCents: 0,
        platformFeeCents: 0,
        depositCents: 0,
        balanceDueCents: 0,
        totalCents: 0,
      },
      serviceLines: [
        {
          serviceId: f.service._id,
          responsibleStaffMembershipId: f.provider._id,
          serviceSnapshot: { name: "Group", pricingMode: "PACKAGE", durationMin: 60 },
          pricingInput: {
            packageProgressId: f.input._id,
            packageItemId: f.input.items[0]?.packageItemId,
          },
          packageContext: {
            packageId: f.definition._id,
            packageName: "Bundle",
            definitionItemId: f.definition.items[0]?.itemId ?? new Types.ObjectId(),
            role: "PURCHASE",
          },
          schedulingSnapshot: {
            version: 1,
            baseDurationMin: 60,
            processingTimeMin: 0,
            bufferAfterMin: 15,
            occupiedDurationMin: 75,
            group: seat,
          },
          amountCents: 0,
          reservationId: joined.reservationId,
          reservationOperationKey: oldInput.idempotencyKey,
          addons: [],
        },
      ],
    });
    const line = booking.serviceLines[0];
    if (!line) throw new Error("Missing line");
    expect(packageReservationPartySize(line)).toBe(1);
    expect(line.pricingInput.personCount).toBeUndefined();
    await services.replaceById(f.business._id, f.service._id, {
      ...serviceFields(f.service),
      perPersonPricing: {
        ratePerPersonCents: 9000,
        minPersons: 1,
        maxPersons: 3,
        durationMin: 60,
        bufferAfterMin: 60,
      },
    });
    const newStart = new Date("2030-08-20T12:00:00Z"),
      newEnd = new Date("2030-08-20T13:15:00Z");
    const destination = await reservations.reserveOrJoin({
      ...slot(f, "new-other-customer"),
      startAt: newStart,
      endAt: newEnd,
    });
    const move = async (abort: boolean) =>
      transaction(async (session) => {
        const current = await acquireSchedulingAdmission(f.business, session);
        const occupied = await verifiedOccupiedMilliseconds(booking, line, session);
        expect(occupied.duration).toBe(75 * 60000);
        await validateSchedulingLine(
          {
            business: current,
            serviceId: f.service._id,
            staffMembershipId: f.provider._id,
            startAt: newStart,
            endAt: new Date(newStart.getTime() + occupied.duration),
            partySize: packageReservationPartySize(line),
            capacityMax: occupied.capacityMax,
            packageGroup: line.schedulingSnapshot?.group,
            allowInactive: false,
            existingAppointment: true,
            fulfilment: booking.fulfilment,
          },
          availability,
          session,
        );
        const next = await reservations.reserveOrJoin(
          { ...slot(f, "move-package-party"), startAt: newStart, endAt: newEnd },
          session,
        );
        await reservations.release({ ...oldInput, reservationId: joined.reservationId }, session);
        await BookingModel.updateOne(
          { _id: booking._id, status: "UPCOMING" },
          {
            $set: {
              "schedule.startAt": newStart,
              "schedule.endAt": newEnd,
              "serviceLines.0.reservationId": next.reservationId,
              "serviceLines.0.reservationOperationKey": "move-package-party",
            },
          },
          { session },
        );
        if (abort) throw new Error("abort synthetic move");
        return next;
      });
    await expect(move(true)).rejects.toThrow("abort synthetic move");
    expect(
      (
        await BookingSlotReservationClaimModel.findOne({
          idempotencyKey: oldInput.idempotencyKey,
        }).orFail()
      ).effect?.state,
    ).toBe("APPLIED");
    expect(
      await BookingSlotReservationClaimModel.countDocuments({
        idempotencyKey: "move-package-party",
      }),
    ).toBe(0);
    expect((await BookingModel.findById(booking._id).orFail()).schedule.startAt).toEqual(startAt);
    const moved = await move(false);
    expect(String(moved.reservationId)).toBe(String(destination.reservationId));
    expect(
      (
        await BookingSlotReservationClaimModel.findOne({
          idempotencyKey: oldInput.idempotencyKey,
        }).orFail()
      ).effect?.state,
    ).toBe("RELEASED");
    const day = await BookingSlotReservationModel.findOne().orFail();
    expect(
      day.intervals.find((row) => row.reservationId.equals(joined.reservationId))?.capacityUsed,
    ).toBe(1);
    expect(
      day.intervals.find((row) => row.reservationId.equals(moved.reservationId))?.capacityUsed,
    ).toBe(2);
  });
});

// Vitest-only authority mock for existing model-valid synthetic first-class fixtures.
vi.mock("../../../src/modules/booking/package-batch-authority.js", () => ({
  verifyPackageBatchActivation: vi.fn(async () => undefined),
}));
