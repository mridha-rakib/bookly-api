/** P4K synthetic seed. Writes ONLY into the harness-owned disposable replica database that
 * p4k-harness.ts has already verified. No production/customer data, no import, no backup.
 * All accounts share one obviously synthetic password and @p4k.invalid addresses. */
import { Types } from "mongoose";
import { AddonModel } from "../../src/modules/addons/addon.model.js";
import { AddonServiceAssignmentModel } from "../../src/modules/addons/addon-service-assignment.model.js";
import { Argon2PasswordHasher } from "../../src/modules/auth/password-hasher.js";
import { BusinessModel } from "../../src/modules/business/business.model.js";
import { cancellationTiers } from "../../src/modules/business-cancellation-policy/business-cancellation-policy.model.js";
import { BusinessCancellationPolicyRepository } from "../../src/modules/business-cancellation-policy/business-cancellation-policy.repository.js";
import { BusinessHoursRepository } from "../../src/modules/business-hours/business-hours.repository.js";
import { BusinessTravelSettingsRepository } from "../../src/modules/business-travel-settings/business-travel-settings.repository.js";
import { PackageModel } from "../../src/modules/packages/package.model.js";
import { CustomerPaymentProfileRepository } from "../../src/modules/payment/customer-payment-profile.repository.js";
import { ServiceModel } from "../../src/modules/services/service.model.js";
import { ServiceCategoryRepository } from "../../src/modules/services/service-category.repository.js";
import { StaffMembershipModel } from "../../src/modules/staff/staff.model.js";
import { StaffScheduleRepository } from "../../src/modules/staff/staff-schedule.repository.js";
import { UserModel, UserProfileModel } from "../../src/modules/user/user.model.js";
import { harnessGateway } from "./p4k-harness-state.js";

export const P4K_PASSWORD = "P4k-Synthetic-Only-123!";
export const P4K_ACCOUNTS = {
  customer: "customer-a@p4k.invalid",
  otherCustomer: "customer-b@p4k.invalid",
  owner: "owner@p4k.invalid",
  supervisor: "supervisor@p4k.invalid",
  staff: "staff@p4k.invalid",
  travelOwner: "travel-owner@p4k.invalid",
  travelStaff: "travel-staff@p4k.invalid",
} as const;
type Role = "CUSTOMER" | "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF";
const days = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;

async function user(email: string, role: Role, firstName: string, hash: string) {
  const _id = new Types.ObjectId();
  await UserModel.create({
    _id,
    normalizedEmail: email,
    passwordHash: hash,
    authProviders: ["PASSWORD"],
    role,
    status: "ACTIVE",
    emailVerifiedAt: new Date(),
    security: { passwordUpdatedAt: new Date() },
  });
  await UserProfileModel.create({ userId: _id, firstName, lastName: "Synthetic", gender: "other" });
  return _id;
}

async function business(input: {
  name: string;
  ownerEmail: string;
  staff: Array<{ email: string; role: "SUPERVISOR" | "STAFF"; name: string }>;
  travel: boolean;
  hash: string;
}) {
  const ownerUserId = await user(
    input.ownerEmail,
    "BUSINESS_OWNER",
    `${input.name} Owner`,
    input.hash,
  );
  const doc = await BusinessModel.create({
    ownerUserId,
    status: "APPROVED",
    name: input.name,
    ownerName: `${input.name} Owner`,
    email: input.ownerEmail,
    phone: { countryCode: "+357", nationalNumber: "99000000", e164: "+35799000000" },
    timezone: "Asia/Nicosia",
    visitType: input.travel ? "TRAVEL_TO_CUSTOMER" : "AT_BUSINESS_LOCATION",
    address: { city: "Larnaca", area: "Center", streetName: "Synthetic", streetNumber: "1" },
    briefDescription: "P4K isolated synthetic Business. Not a real venue.",
    category: "Wellness & Beauty",
    categoryKey: "BEAUTY_WELLNESS",
    subcategories: ["P4K"],
  });
  const memberships = [];
  for (const s of input.staff) {
    const userId = await user(s.email, s.role, s.name, input.hash);
    memberships.push(
      await StaffMembershipModel.create({
        businessId: doc._id,
        userId,
        createdByUserId: ownerUserId,
        employmentActive: true,
        role: s.role,
      }),
    );
  }
  const category = await new ServiceCategoryRepository().create({
    businessId: doc._id,
    name: "P4K",
    nameKey: "p4k",
  });
  const assigned = memberships.map((m) => m._id);
  const common = {
    businessId: doc._id,
    status: "ACTIVE",
    isPackageDeal: false,
    assignedStaffMembershipIds: assigned,
    servedCities: ["Larnaca"],
    scheduleMode: "AUTO",
    category: doc.category,
    subcategory: "P4K",
    serviceCategoryId: category._id,
    sessionExpiryAlert: { enabled: false },
  };
  const fixed = (name: string, priceCents: number) =>
    ServiceModel.create({
      ...common,
      name,
      pricingMode: "FIXED",
      fixedPricing: {
        priceCents,
        durationMin: 60,
        bookingIntervalMin: 15,
        processingTimeMin: 0,
        bufferAfterMin: 10,
      },
    });
  const hair = await fixed("Hair", 9000),
    facial = await fixed("Facial", 7000);
  const yoga = await ServiceModel.create({
    ...common,
    name: "Group Yoga",
    pricingMode: "PER_PERSON",
    perPersonPricing: {
      ratePerPersonCents: 3000,
      minPersons: 1,
      maxPersons: 3,
      durationMin: 60,
      bookingIntervalMin: 15,
      bufferAfterMin: 15,
    },
  });
  const addon = await AddonModel.create({
    businessId: doc._id,
    status: "ACTIVE",
    name: "Synthetic scalp treatment",
    priceCents: 500,
  });
  for (const service of [hair, facial])
    await AddonServiceAssignmentModel.create({
      businessId: doc._id,
      addonId: addon._id,
      serviceId: service._id,
    });
  const schedules = new StaffScheduleRepository();
  // Whole-day availability so complete/no-show can be exercised soon after a real start time.
  for (const m of memberships)
    await schedules.replace(
      m._id,
      doc._id,
      days.map((dayOfWeek) => ({
        dayOfWeek,
        intervals: [{ startTime: "00:00", endTime: "23:59" }],
      })),
    );
  await new BusinessHoursRepository().replace(
    doc._id,
    days.map((dayOfWeek) => ({
      dayOfWeek,
      isOpen: true,
      slots: [{ startTime: "00:00", endTime: "23:59" }],
    })),
  );
  if (input.travel)
    await new BusinessTravelSettingsRepository().upsertByBusinessId(doc._id, [
      { city: "Larnaca", active: true, feeCents: 300 },
    ]);
  await new BusinessCancellationPolicyRepository().replace(
    doc._id,
    cancellationTiers.map((tier, index) =>
      index === 0
        ? { tier, mode: "FREE" as const }
        : { tier, mode: "PERCENTAGE" as const, percentage: 20 + index * 20 },
    ),
    100,
  );
  const definition = (
    name: string,
    validity: { mode: "FINITE"; months: 6 | 12 } | { mode: "FOREVER" },
    bundlePriceCents: number,
    items: Array<{
      serviceId: Types.ObjectId;
      includedSessions: number;
      referenceUnitPriceCents: number;
      penaltyBasisCents: number;
    }>,
  ) =>
    PackageModel.create({
      businessId: doc._id,
      name,
      revision: 1,
      status: "ACTIVE",
      isFeatured: false,
      bundlePriceCents,
      category: doc.category,
      subcategory: "P4K",
      serviceCategoryId: category._id,
      contractTerms: { version: 2, validity, penaltyPolicyVersion: 1 },
      items: items.map((item) => ({ itemId: new Types.ObjectId(), ...item })),
    });
  const packages = {
    // Small FINITE6 so credit exhaustion is reachable interactively.
    finite6: await definition("P4K FINITE6 Hair2 Facial1", { mode: "FINITE", months: 6 }, 20000, [
      {
        serviceId: hair._id,
        includedSessions: 2,
        referenceUnitPriceCents: 9000,
        penaltyBasisCents: 2000,
      },
      {
        serviceId: facial._id,
        includedSessions: 1,
        referenceUnitPriceCents: 7000,
        penaltyBasisCents: 1000,
      },
    ]),
    finite12: await definition(
      "P4K FINITE12 Hair3 Facial2 Yoga1",
      { mode: "FINITE", months: 12 },
      36000,
      [
        {
          serviceId: hair._id,
          includedSessions: 3,
          referenceUnitPriceCents: 9000,
          penaltyBasisCents: 2000,
        },
        {
          serviceId: facial._id,
          includedSessions: 2,
          referenceUnitPriceCents: 7000,
          penaltyBasisCents: 1000,
        },
        {
          serviceId: yoga._id,
          includedSessions: 1,
          referenceUnitPriceCents: 3000,
          penaltyBasisCents: 0,
        },
      ],
    ),
    forever: await definition("P4K FOREVER Hair1 Facial1", { mode: "FOREVER" }, 15000, [
      {
        serviceId: hair._id,
        includedSessions: 1,
        referenceUnitPriceCents: 9000,
        penaltyBasisCents: 2000,
      },
      {
        serviceId: facial._id,
        includedSessions: 1,
        referenceUnitPriceCents: 7000,
        penaltyBasisCents: 1000,
      },
    ]),
  };
  return {
    id: doc._id,
    ownerUserId,
    memberships: memberships.map((m) => ({ id: m._id, userId: m.userId, role: m.role })),
    services: { hair: hair._id, facial: facial._id, yoga: yoga._id },
    addonId: addon._id,
    packages,
  };
}

export async function seedP4k() {
  const hash = await new Argon2PasswordHasher().hash(P4K_PASSWORD);
  const customer = await user(P4K_ACCOUNTS.customer, "CUSTOMER", "Customer A", hash);
  const otherCustomer = await user(P4K_ACCOUNTS.otherCustomer, "CUSTOMER", "Customer B", hash);
  const venue = await business({
    name: "P4K Synthetic Studio",
    ownerEmail: P4K_ACCOUNTS.owner,
    travel: false,
    hash,
    staff: [
      { email: P4K_ACCOUNTS.supervisor, role: "SUPERVISOR", name: "Supervisor" },
      { email: P4K_ACCOUNTS.staff, role: "STAFF", name: "Staff" },
    ],
  });
  const travel = await business({
    name: "P4K Synthetic Mobile",
    ownerEmail: P4K_ACCOUNTS.travelOwner,
    travel: true,
    hash,
    staff: [{ email: P4K_ACCOUNTS.travelStaff, role: "STAFF", name: "Travel Staff" }],
  });
  // Synthetic saved card for Customer A only; exists solely inside the fake gateway.
  const profiles = new CustomerPaymentProfileRepository();
  await profiles.createIfMissing(customer, "cus_p4k_synthetic");
  await profiles.savePaymentMethod({
    userId: customer,
    defaultPaymentMethodId: "pm_p4k_synthetic",
    cardBrand: "visa",
    cardLast4: "4242",
    cardExpMonth: 12,
    cardExpYear: 2035,
  });
  harnessGateway.seedPaymentMethod("pm_p4k_synthetic", {
    paymentMethodId: "pm_p4k_synthetic",
    customerId: "cus_p4k_synthetic",
    brand: "visa",
    last4: "4242",
    expMonth: 12,
    expYear: 2035,
  });
  return { password: P4K_PASSWORD, accounts: P4K_ACCOUNTS, customer, otherCustomer, venue, travel };
}
export type P4kSeed = Awaited<ReturnType<typeof seedP4k>>;
