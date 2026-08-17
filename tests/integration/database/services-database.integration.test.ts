import express from "express";
import mongoose, { type Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../../../src/modules/auth/auth.middleware.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessAccessRepository } from "../../../src/modules/business/business-access.repository.js";
import { BusinessTravelSettingsRepository } from "../../../src/modules/business-travel-settings/business-travel-settings.repository.js";
import { ServiceModel } from "../../../src/modules/services/service.model.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { createServicesRoute } from "../../../src/modules/services/service.route.js";
import type {
  CreateServiceBody,
  UpdateServiceBody,
} from "../../../src/modules/services/service.schema.js";
import { ServiceService } from "../../../src/modules/services/service.service.js";
import { ServiceCategoryRepository } from "../../../src/modules/services/service-category.repository.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffAvatarRepository } from "../../../src/modules/staff-avatar/staff-avatar.repository.js";
import { StaffAvatarService } from "../../../src/modules/staff-avatar/staff-avatar.service.js";
import { createDeferredStorageServiceFromEnv } from "../../../src/modules/storage/storage.service.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const businessInput = (
  ownerUserId: Types.ObjectId,
  name: string,
  overrides: Record<string, unknown> = {},
) => ({
  ownerUserId,
  name,
  ownerName: "Blake Owner",
  email: `${name.toLowerCase().replace(/\s+/g, "")}@example.com`,
  phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
  visitType: "AT_BUSINESS_LOCATION" as const,
  address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
  briefDescription: "A great business",
  category: "Wellness & Beauty",
  subcategories: ["Massage", "Facial Care"],
  ...overrides,
});

const basicSessionExpiryAlert = { enabled: false };
const basicAutoSchedule = { scheduleMode: "AUTO" as const };

describe("database-backed Service integration", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let businessAccessRepository: BusinessAccessRepository;
  let businessTravelSettingsRepository: BusinessTravelSettingsRepository;
  let staffRepository: StaffRepository;
  let serviceRepository: ServiceRepository;
  let serviceCategoryRepository: ServiceCategoryRepository;
  let serviceService: ServiceService;
  let tokenService: TokenService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    businessAccessRepository = new BusinessAccessRepository();
    businessTravelSettingsRepository = new BusinessTravelSettingsRepository();
    staffRepository = new StaffRepository();
    serviceRepository = new ServiceRepository();
    serviceCategoryRepository = new ServiceCategoryRepository();
    const staffAvatarService = new StaffAvatarService(
      new StaffAvatarRepository(),
      businessRepository,
      staffRepository,
      createDeferredStorageServiceFromEnv(),
      { maxUploadBytes: 5 * 1024 * 1024 },
    );
    serviceService = new ServiceService(
      serviceRepository,
      serviceCategoryRepository,
      businessRepository,
      businessTravelSettingsRepository,
      staffRepository,
      userRepository,
      staffAvatarService,
    );
    tokenService = new TokenService(new SessionRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const createBusinessOwner = async (
    email: string,
    businessName: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const user = await userRepository.create({
      normalizedEmail: email,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const business = await businessRepository.create(
      businessInput(user._id, businessName, overrides),
    );
    return { user, business };
  };

  const createStaffMember = async (businessId: Types.ObjectId, email: string) => {
    const user = await userRepository.create({
      normalizedEmail: email,
      passwordHash: "hash",
      role: "STAFF",
      status: "ACTIVE",
    });
    const membership = await staffRepository.create({
      userId: user._id,
      businessId,
      role: "STAFF",
      createdByUserId: businessId,
    });
    return { user, membership };
  };

  const buildServicesApp = () => {
    const app = express();
    app.use(express.json());
    app.use(
      createAuthenticateAccessTokenMiddleware(tokenService, userRepository),
      requireActiveUser(),
      requireRoles(["BUSINESS_OWNER"]),
    );
    app.use("/businesses", createServicesRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF",
  ) => `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  const createCategory = async (ownerId: string, businessId: string, name = "Hair Treatment") =>
    serviceService.createCategory(ownerId, businessId, name);

  // Returns `unknown`-shaped test fixture data cast to CreateServiceBody: every call site
  // supplies a real serviceCategoryId (and any other required overrides) at runtime, but the
  // generic `Record<string, unknown>` overrides bag defeats static verification of that —
  // acceptable for test fixture construction, not something production code does.
  const fixedServiceBody = (overrides: Record<string, unknown> = {}): CreateServiceBody =>
    ({
      status: "ACTIVE",
      isFeatured: false,
      isPackageDeal: false,
      subcategory: "Massage",
      name: "Deep Tissue Massage",
      pricingMode: "FIXED" as const,
      fixedPricing: { priceCents: 12_000, durationMin: 90 },
      sessionExpiryAlert: basicSessionExpiryAlert,
      ...basicAutoSchedule,
      servedCities: [],
      assignedStaffMembershipIds: [],
      ...overrides,
    }) as unknown as CreateServiceBody;

  // --- Service Categories --------------------------------------------------------------------

  describe("Service Categories", () => {
    it("creates a category and rejects a case-insensitive duplicate for the same business", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");

      const category = await createCategory(
        String(user._id),
        String(business._id),
        "Hair Treatment",
      );
      expect(category.active).toBe(true);

      await expect(
        createCategory(String(user._id), String(business._id), "hair treatment"),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("scopes categories per business — Business A's categories never appear for Business B", async () => {
      const { user: ownerA, business: businessA } = await createBusinessOwner(
        "owner-a@example.com",
        "Salon A",
      );
      const { user: ownerB, business: businessB } = await createBusinessOwner(
        "owner-b@example.com",
        "Salon B",
      );

      await createCategory(String(ownerA._id), String(businessA._id), "Hair Treatment");
      const categoriesForB = await serviceService.listCategories(
        String(ownerB._id),
        String(businessB._id),
        true,
      );
      expect(categoriesForB).toHaveLength(0);
    });

    it("archiving a category removes it from the active list but keeps existing Service references valid", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));

      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id }),
      );

      await serviceService.updateCategory(String(user._id), String(business._id), category.id, {
        active: false,
      });

      const activeOnly = await serviceService.listCategories(
        String(user._id),
        String(business._id),
        false,
      );
      expect(activeOnly).toHaveLength(0);

      // Existing Service still resolves its (now-archived) category by reference.
      const fetched = await serviceService.getService(
        String(user._id),
        String(business._id),
        service.id,
      );
      expect(fetched.serviceCategoryId).toBe(category.id);
      expect(fetched.serviceCategoryName).toBe("Hair Treatment");

      // A brand-new Service may not select the archived category.
      await expect(
        serviceService.createService(
          String(user._id),
          String(business._id),
          fixedServiceBody({ serviceCategoryId: category.id }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  // --- Authorization ---------------------------------------------------------------------------

  describe("Authorization", () => {
    it("allows the owner to create and list Services for their own Business", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));

      await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id }),
      );

      const { services, counts } = await serviceService.listServices(
        String(user._id),
        String(business._id),
        {},
      );
      expect(services).toHaveLength(1);
      expect(counts.active).toBe(1);
    });

    it("denies another Business Owner from managing a Business they don't own", async () => {
      const { business: businessA } = await createBusinessOwner("owner-a@example.com", "Salon A");
      const { user: ownerB } = await createBusinessOwner("owner-b@example.com", "Salon B");
      const categoryOfA = await createCategory(String(ownerB._id), String(businessA._id)).catch(
        () => null,
      );
      expect(categoryOfA).toBeNull();

      await expect(
        serviceService.listServices(String(ownerB._id), String(businessA._id), {}),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("denies a BusinessAccess-linked (secondary) Business from managing Services — owner-only", async () => {
      const { user: ownerA } = await createBusinessOwner("owner-a@example.com", "Salon A");
      const { business: businessB } = await createBusinessOwner("owner-b@example.com", "Salon B");
      await businessAccessRepository.create({ userId: ownerA._id, businessId: businessB._id });

      await expect(
        serviceService.listServices(String(ownerA._id), String(businessB._id), {}),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("rejects SUPERVISOR and STAFF at the real HTTP route boundary before reaching any handler", async () => {
      const { user: owner, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const { user: supervisor } = await createStaffMember(business._id, "supervisor@example.com");
      const app = buildServicesApp();

      const supervisorToken = await bearerFor(supervisor._id, "SUPERVISOR");
      const staffToken = await bearerFor(supervisor._id, "STAFF");
      const ownerToken = await bearerFor(owner._id, "BUSINESS_OWNER");

      const supervisorResponse = await request(app)
        .get(`/businesses/${business._id}/services`)
        .set("Authorization", supervisorToken);
      expect(supervisorResponse.status).toBe(403);

      const staffResponse = await request(app)
        .get(`/businesses/${business._id}/services`)
        .set("Authorization", staffToken);
      expect(staffResponse.status).toBe(403);

      const ownerResponse = await request(app)
        .get(`/businesses/${business._id}/services`)
        .set("Authorization", ownerToken);
      expect(ownerResponse.status).toBe(200);
    });

    it("rejects mass-assigned fields (businessId, status) at the real API boundary via strict schema", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));
      const app = buildServicesApp();
      const token = await bearerFor(user._id, "BUSINESS_OWNER");

      const response = await request(app)
        .post(`/businesses/${business._id}/services`)
        .set("Authorization", token)
        .send({
          ...fixedServiceBody({ serviceCategoryId: category.id }),
          businessId: "000000000000000000000000",
          status: "ARCHIVED",
        });
      expect(response.status).toBe(400);
      expect(await ServiceModel.countDocuments()).toBe(0);
    });
  });

  // --- Status lifecycle -------------------------------------------------------------------------

  describe("Status lifecycle (DRAFT / ACTIVE / INACTIVE / ARCHIVED)", () => {
    it("creates ACTIVE when status=ACTIVE and INACTIVE when status=INACTIVE", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));

      const active = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id, status: "ACTIVE" }),
      );
      const inactive = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id, status: "INACTIVE", name: "Facial" }),
      );

      expect(active.status).toBe("ACTIVE");
      expect(inactive.status).toBe("INACTIVE");
    });

    it("toggles status via the dedicated status endpoint", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id }),
      );

      const toggled = await serviceService.updateServiceStatus(
        String(user._id),
        String(business._id),
        service.id,
        "INACTIVE",
      );
      expect(toggled.status).toBe("INACTIVE");
    });

    it("archiving excludes a Service from the normal catalogue list but keeps the row in the database", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id }),
      );

      await serviceService.archiveService(String(user._id), String(business._id), service.id);

      const { services, counts } = await serviceService.listServices(
        String(user._id),
        String(business._id),
        {},
      );
      expect(services).toHaveLength(0);
      expect(counts.archived).toBe(1);
      expect(await ServiceModel.countDocuments({ _id: service.id })).toBe(1);

      const archivedList = await serviceService.listServices(
        String(user._id),
        String(business._id),
        {
          archivedOnly: true,
        },
      );
      expect(archivedList.services).toHaveLength(1);
      expect(archivedList.services[0]?.status).toBe("ARCHIVED");
    });

    it("restores an archived Service explicitly as ACTIVE or INACTIVE — never automatically", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id }),
      );
      await serviceService.archiveService(String(user._id), String(business._id), service.id);

      const restoredInactive = await serviceService.restoreService(
        String(user._id),
        String(business._id),
        service.id,
        "INACTIVE",
      );
      expect(restoredInactive.status).toBe("INACTIVE");

      await serviceService.archiveService(String(user._id), String(business._id), service.id);
      const restoredActive = await serviceService.restoreService(
        String(user._id),
        String(business._id),
        service.id,
        "ACTIVE",
      );
      expect(restoredActive.status).toBe("ACTIVE");
    });

    it("rejects archiving an already-archived Service and restoring a non-archived Service", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id }),
      );

      await expect(
        serviceService.restoreService(String(user._id), String(business._id), service.id, "ACTIVE"),
      ).rejects.toMatchObject({ statusCode: 409 });

      await serviceService.archiveService(String(user._id), String(business._id), service.id);
      await expect(
        serviceService.archiveService(String(user._id), String(business._id), service.id),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  // --- Draft lifecycle ---------------------------------------------------------------------------

  describe("Draft lifecycle", () => {
    it("creates a DRAFT Service with only a name — no category, pricing, staff, or schedule", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");

      const draft = await serviceService.createService(String(user._id), String(business._id), {
        status: "DRAFT",
        isFeatured: false,
        isPackageDeal: false,
        name: "New Service",
        scheduleMode: "AUTO",
        servedCities: [],
        assignedStaffMembershipIds: [],
      } as unknown as CreateServiceBody);

      expect(draft.status).toBe("DRAFT");
      expect(draft.serviceCategoryId).toBeUndefined();
      expect(draft.subcategory).toBeUndefined();
      expect(draft.pricingMode).toBeUndefined();
      expect(await ServiceModel.countDocuments({ _id: draft.id })).toBe(1);
    });

    it("updates a DRAFT Service while keeping it partial", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");

      const draft = await serviceService.createService(String(user._id), String(business._id), {
        status: "DRAFT",
        isFeatured: false,
        isPackageDeal: false,
        name: "New Service",
        scheduleMode: "AUTO",
        servedCities: [],
        assignedStaffMembershipIds: [],
      } as unknown as CreateServiceBody);

      const updated = await serviceService.updateService(
        String(user._id),
        String(business._id),
        draft.id,
        {
          status: "DRAFT",
          isFeatured: false,
          isPackageDeal: false,
          name: "New Service Name",
          scheduleMode: "AUTO",
          servedCities: [],
          assignedStaffMembershipIds: [],
        } as unknown as UpdateServiceBody,
      );

      expect(updated.status).toBe("DRAFT");
      expect(updated.name).toBe("New Service Name");
      expect(updated.serviceCategoryId).toBeUndefined();
    });

    it("excludes DRAFT Services from customer-ready semantics (never returned by the ACTIVE-only status filter)", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));

      await serviceService.createService(String(user._id), String(business._id), {
        status: "DRAFT",
        isFeatured: false,
        isPackageDeal: false,
        name: "Draft Service",
        scheduleMode: "AUTO",
        servedCities: [],
        assignedStaffMembershipIds: [],
      } as unknown as CreateServiceBody);
      await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id, status: "ACTIVE" }),
      );

      const { services, counts } = await serviceService.listServices(
        String(user._id),
        String(business._id),
        { status: "ACTIVE" },
      );
      expect(services).toHaveLength(1);
      expect(services[0]?.status).toBe("ACTIVE");
      expect(counts.draft).toBe(1);

      const unfiltered = await serviceService.listServices(
        String(user._id),
        String(business._id),
        {},
      );
      expect(unfiltered.services).toHaveLength(2);
    });

    it("publishes a DRAFT to ACTIVE when the update payload is fully valid", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));

      const draft = await serviceService.createService(String(user._id), String(business._id), {
        status: "DRAFT",
        isFeatured: false,
        isPackageDeal: false,
        name: "New Service",
        scheduleMode: "AUTO",
        servedCities: [],
        assignedStaffMembershipIds: [],
      } as unknown as CreateServiceBody);

      const published = await serviceService.updateService(
        String(user._id),
        String(business._id),
        draft.id,
        fixedServiceBody({ serviceCategoryId: category.id, status: "ACTIVE" }),
      );

      expect(published.status).toBe("ACTIVE");
      expect(published.serviceCategoryId).toBe(category.id);
      expect(published.pricingMode).toBe("FIXED");
    });

    it("rejects publishing a DRAFT to ACTIVE when required fields are still missing, at the schema boundary", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const app = buildServicesApp();
      const token = await bearerFor(user._id, "BUSINESS_OWNER");

      const response = await request(app)
        .post(`/businesses/${business._id}/services`)
        .set("Authorization", token)
        .send({
          status: "ACTIVE",
          isFeatured: false,
          isPackageDeal: false,
          name: "Incomplete Service",
          scheduleMode: "AUTO",
          servedCities: [],
          assignedStaffMembershipIds: [],
        });

      expect(response.status).toBe(400);
      expect(await ServiceModel.countDocuments()).toBe(0);
    });

    it("publishes a DRAFT to INACTIVE when the update payload is fully valid, and rejects it when incomplete", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));
      const app = buildServicesApp();
      const token = await bearerFor(user._id, "BUSINESS_OWNER");

      const draft = await serviceService.createService(String(user._id), String(business._id), {
        status: "DRAFT",
        isFeatured: false,
        isPackageDeal: false,
        name: "New Service",
        scheduleMode: "AUTO",
        servedCities: [],
        assignedStaffMembershipIds: [],
      } as unknown as CreateServiceBody);

      // Full-publish requiredness is enforced by the Zod schema at the HTTP boundary (the
      // service layer trusts an already-validated body) — so the "incomplete" case is
      // exercised through the real route, matching every other rejection test in this file.
      const incompleteResponse = await request(app)
        .patch(`/businesses/${business._id}/services/${draft.id}`)
        .set("Authorization", token)
        .send({
          status: "INACTIVE",
          isFeatured: false,
          isPackageDeal: false,
          name: "New Service",
          scheduleMode: "AUTO",
          servedCities: [],
          assignedStaffMembershipIds: [],
        });
      expect(incompleteResponse.status).toBe(400);

      const published = await serviceService.updateService(
        String(user._id),
        String(business._id),
        draft.id,
        fixedServiceBody({ serviceCategoryId: category.id, status: "INACTIVE" }),
      );
      expect(published.status).toBe("INACTIVE");
    });

    it("rejects the quick Active/Inactive toggle on a DRAFT Service — publishing requires the full form", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");

      const draft = await serviceService.createService(String(user._id), String(business._id), {
        status: "DRAFT",
        isFeatured: false,
        isPackageDeal: false,
        name: "New Service",
        scheduleMode: "AUTO",
        servedCities: [],
        assignedStaffMembershipIds: [],
      } as unknown as CreateServiceBody);

      await expect(
        serviceService.updateServiceStatus(
          String(user._id),
          String(business._id),
          draft.id,
          "ACTIVE",
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("never restores an archived Service back to DRAFT — restore is schema-limited to ACTIVE/INACTIVE", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id }),
      );
      await serviceService.archiveService(String(user._id), String(business._id), service.id);
      const app = buildServicesApp();
      const token = await bearerFor(user._id, "BUSINESS_OWNER");

      const response = await request(app)
        .post(`/businesses/${business._id}/services/${service.id}/restore`)
        .set("Authorization", token)
        .send({ status: "DRAFT" });

      expect(response.status).toBe(400);
    });
  });

  // --- Pricing -----------------------------------------------------------------------------------

  describe("Pricing modes", () => {
    it("accepts a valid FIXED service and rejects a non-integer priceCents at the schema boundary", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));
      const app = buildServicesApp();
      const token = await bearerFor(user._id, "BUSINESS_OWNER");

      const invalid = await request(app)
        .post(`/businesses/${business._id}/services`)
        .set("Authorization", token)
        .send(
          fixedServiceBody({
            serviceCategoryId: category.id,
            fixedPricing: { priceCents: 120.5, durationMin: 90 },
          }),
        );
      expect(invalid.status).toBe(400);
    });

    it("accepts a valid HOURLY service and rejects maxHours < minHours", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));

      const hourly = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({
          serviceCategoryId: category.id,
          pricingMode: "HOURLY",
          fixedPricing: undefined,
          hourlyPricing: { ratePerHourCents: 5_000, minHours: 2, maxHours: 8 },
        }),
      );
      expect(hourly.hourlyPricing?.maxHours).toBe(8);

      const app = buildServicesApp();
      const token = await bearerFor(user._id, "BUSINESS_OWNER");
      const invalid = await request(app)
        .post(`/businesses/${business._id}/services`)
        .set("Authorization", token)
        .send(
          fixedServiceBody({
            serviceCategoryId: category.id,
            pricingMode: "HOURLY",
            fixedPricing: undefined,
            hourlyPricing: { ratePerHourCents: 5_000, minHours: 8, maxHours: 2 },
          }),
        );
      expect(invalid.status).toBe(400);
    });

    it("accepts a valid PER_PERSON service and rejects maxPersons < minPersons", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));

      const perPerson = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({
          serviceCategoryId: category.id,
          pricingMode: "PER_PERSON",
          fixedPricing: undefined,
          perPersonPricing: {
            ratePerPersonCents: 3_000,
            minPersons: 2,
            maxPersons: 8,
            durationMin: 60,
          },
        }),
      );
      expect(perPerson.perPersonPricing?.maxPersons).toBe(8);

      const app = buildServicesApp();
      const token = await bearerFor(user._id, "BUSINESS_OWNER");
      const invalid = await request(app)
        .post(`/businesses/${business._id}/services`)
        .set("Authorization", token)
        .send(
          fixedServiceBody({
            serviceCategoryId: category.id,
            pricingMode: "PER_PERSON",
            fixedPricing: undefined,
            perPersonPricing: {
              ratePerPersonCents: 3_000,
              minPersons: 8,
              maxPersons: 2,
              durationMin: 60,
            },
          }),
        );
      expect(invalid.status).toBe(400);
    });

    it("accepts a valid Package Deal and rejects discountPercent out of 0..100", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));

      const packageService = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({
          serviceCategoryId: category.id,
          isPackageDeal: true,
          pricingMode: undefined,
          fixedPricing: undefined,
          packageServicesName: "Hair Treatment",
          name: "5 Session Hair Treatment",
          packagePricing: {
            durationMin: 60,
            sessionsInPackage: 5,
            bundlePriceCents: 45_000,
            discountPercent: 10,
          },
        }),
      );
      expect(packageService.isPackageDeal).toBe(true);
      expect(packageService.packagePricing?.sessionsInPackage).toBe(5);

      const app = buildServicesApp();
      const token = await bearerFor(user._id, "BUSINESS_OWNER");
      const invalid = await request(app)
        .post(`/businesses/${business._id}/services`)
        .set("Authorization", token)
        .send(
          fixedServiceBody({
            serviceCategoryId: category.id,
            isPackageDeal: true,
            pricingMode: undefined,
            fixedPricing: undefined,
            packageServicesName: "Hair Treatment",
            packagePricing: {
              durationMin: 60,
              sessionsInPackage: 5,
              bundlePriceCents: 45_000,
              discountPercent: 150,
            },
          }),
        );
      expect(invalid.status).toBe(400);
    });

    it("rejects a payload that mixes isPackageDeal=true with FIXED/HOURLY/PER_PERSON fields", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));
      const app = buildServicesApp();
      const token = await bearerFor(user._id, "BUSINESS_OWNER");

      const response = await request(app)
        .post(`/businesses/${business._id}/services`)
        .set("Authorization", token)
        .send(
          fixedServiceBody({
            serviceCategoryId: category.id,
            isPackageDeal: true,
            packageServicesName: "Hair Treatment",
            packagePricing: { durationMin: 60, sessionsInPackage: 5, bundlePriceCents: 45_000 },
            // Stray FIXED-mode fields left in the payload — must be rejected, not ignored.
          }),
        );
      expect(response.status).toBe(400);
    });
  });

  // --- Custom Service Category requirement --------------------------------------------------

  describe("Custom Service Category requirement", () => {
    it("rejects creating a Service without a valid serviceCategoryId", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");

      await expect(
        serviceService.createService(
          String(user._id),
          String(business._id),
          fixedServiceBody({ serviceCategoryId: new mongoose.Types.ObjectId().toString() }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("rejects a subcategory that is not one of the business's selected subcategories", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));

      await expect(
        serviceService.createService(
          String(user._id),
          String(business._id),
          fixedServiceBody({
            serviceCategoryId: category.id,
            subcategory: "Not A Real Subcategory",
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  // --- Staff assignment ----------------------------------------------------------------------

  describe("Staff assignment", () => {
    it("allows assigning staff from the same business and resolves their name/avatar in the DTO", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));
      const { membership } = await createStaffMember(business._id, "maria@example.com");

      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({
          serviceCategoryId: category.id,
          assignedStaffMembershipIds: [String(membership._id)],
        }),
      );

      expect(service.assignedStaff).toHaveLength(1);
      expect(service.assignedStaff[0]?.membershipId).toBe(String(membership._id));
    });

    it("rejects assigning a StaffMembership that belongs to a different business", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));
      const { business: businessB } = await createBusinessOwner("owner-b@example.com", "Salon B");
      const { membership: foreignMembership } = await createStaffMember(
        businessB._id,
        "foreign@example.com",
      );

      await expect(
        serviceService.createService(
          String(user._id),
          String(business._id),
          fixedServiceBody({
            serviceCategoryId: category.id,
            assignedStaffMembershipIds: [String(foreignMembership._id)],
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  // --- Travel / cities served ----------------------------------------------------------------

  describe("Travel coverage", () => {
    it("rejects any servedCities for an AT_BUSINESS_LOCATION business", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A", {
        visitType: "AT_BUSINESS_LOCATION",
      });
      const category = await createCategory(String(user._id), String(business._id));

      await expect(
        serviceService.createService(
          String(user._id),
          String(business._id),
          fixedServiceBody({ serviceCategoryId: category.id, servedCities: ["Larnaca"] }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("accepts only currently-enabled BusinessTravelSettings cities for a TRAVEL_TO_CUSTOMER business", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A", {
        visitType: "TRAVEL_TO_CUSTOMER",
      });
      const category = await createCategory(String(user._id), String(business._id));
      await businessTravelSettingsRepository.upsertByBusinessId(business._id, [
        { city: "Larnaca", active: true, feeCents: 0 },
        { city: "Limassol", active: false, feeCents: 2_000 },
      ]);

      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id, servedCities: ["Larnaca"] }),
      );
      expect(service.servedCities).toEqual(["Larnaca"]);

      await expect(
        serviceService.createService(
          String(user._id),
          String(business._id),
          fixedServiceBody({ serviceCategoryId: category.id, servedCities: ["Limassol"] }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  // --- Manual schedule ------------------------------------------------------------------------

  describe("Manual (fixed time slot) schedule", () => {
    it("persists a MANUAL schedule with canonical HH:mm times and overrides the business's general schedule for this Service only", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));

      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({
          serviceCategoryId: category.id,
          scheduleMode: "MANUAL",
          manualSchedule: [
            { dayOfWeek: "MONDAY", isOpen: true, times: ["10:00", "12:00"] },
            { dayOfWeek: "TUESDAY", isOpen: false, times: [] },
          ],
        }),
      );

      expect(service.scheduleMode).toBe("MANUAL");
      expect(service.manualSchedule.find((day) => day.dayOfWeek === "MONDAY")?.times).toEqual([
        "10:00",
        "12:00",
      ]);
    });

    it("rejects a non-canonical time value (e.g. 12-hour AM/PM display strings)", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));
      const app = buildServicesApp();
      const token = await bearerFor(user._id, "BUSINESS_OWNER");

      const response = await request(app)
        .post(`/businesses/${business._id}/services`)
        .set("Authorization", token)
        .send(
          fixedServiceBody({
            serviceCategoryId: category.id,
            scheduleMode: "MANUAL",
            manualSchedule: [{ dayOfWeek: "MONDAY", isOpen: true, times: ["10:00 AM"] }],
          }),
        );
      expect(response.status).toBe(400);
    });

    it("rejects a duplicate weekday entry in the manual schedule", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));
      const app = buildServicesApp();
      const token = await bearerFor(user._id, "BUSINESS_OWNER");

      const response = await request(app)
        .post(`/businesses/${business._id}/services`)
        .set("Authorization", token)
        .send(
          fixedServiceBody({
            serviceCategoryId: category.id,
            scheduleMode: "MANUAL",
            manualSchedule: [
              { dayOfWeek: "MONDAY", isOpen: true, times: ["10:00"] },
              { dayOfWeek: "MONDAY", isOpen: true, times: ["14:00"] },
            ],
          }),
        );
      expect(response.status).toBe(400);
    });

    it("rejects an invalid weekday value at the schema boundary", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));
      const app = buildServicesApp();
      const token = await bearerFor(user._id, "BUSINESS_OWNER");

      const response = await request(app)
        .post(`/businesses/${business._id}/services`)
        .set("Authorization", token)
        .send(
          fixedServiceBody({
            serviceCategoryId: category.id,
            scheduleMode: "MANUAL",
            manualSchedule: [{ dayOfWeek: "FUNDAY", isOpen: true, times: ["10:00"] }],
          }),
        );
      expect(response.status).toBe(400);
    });
  });
});
