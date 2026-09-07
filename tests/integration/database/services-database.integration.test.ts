import express from "express";
import mongoose, { type Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { PackageProgressModel } from "../../../src/modules/package-progress/package-progress.model.js";
import { PackageProgressRepository } from "../../../src/modules/package-progress/package-progress.repository.js";
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
      new PackageProgressRepository(),
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

    // Batch — Service Category Rename + Reactivate frontend wiring: the backend contract these
    // tests prove already existed (updateCategory/{name,active} via the same generic PATCH) —
    // this batch only wired the Owner UI against it, so these close a pre-existing coverage gap
    // rather than proving new behavior.

    it("renames an active category — same id, Services referencing it keep resolving with the new name", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id), "Hair");

      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id }),
      );

      const renamed = await serviceService.updateCategory(
        String(user._id),
        String(business._id),
        category.id,
        { name: "Hair & Styling" },
      );
      expect(renamed.id).toBe(category.id);
      expect(renamed.name).toBe("Hair & Styling");
      expect(renamed.active).toBe(true);

      const fetched = await serviceService.getService(
        String(user._id),
        String(business._id),
        service.id,
      );
      expect(fetched.serviceCategoryId).toBe(category.id);
      expect(fetched.serviceCategoryName).toBe("Hair & Styling");
    });

    it("rejects renaming to a name already used by another category — including an archived one — and leaves it unchanged", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const active = await createCategory(String(user._id), String(business._id), "Massage");
      const archived = await createCategory(String(user._id), String(business._id), "Hair");
      await serviceService.updateCategory(String(user._id), String(business._id), archived.id, {
        active: false,
      });

      await expect(
        serviceService.updateCategory(String(user._id), String(business._id), active.id, {
          name: "Hair",
        }),
      ).rejects.toMatchObject({ statusCode: 409 });

      const stillActive = await serviceService.listCategories(
        String(user._id),
        String(business._id),
        false,
      );
      expect(stillActive.map((c) => c.name)).toContain("Massage");
    });

    it("a cross-business Owner cannot rename or reactivate another business's category", async () => {
      const { user: ownerA, business: businessA } = await createBusinessOwner(
        "owner-a@example.com",
        "Salon A",
      );
      const { user: ownerB, business: businessB } = await createBusinessOwner(
        "owner-b@example.com",
        "Salon B",
      );
      const category = await createCategory(String(ownerA._id), String(businessA._id), "Hair");
      await serviceService.updateCategory(String(ownerA._id), String(businessA._id), category.id, {
        active: false,
      });

      await expect(
        serviceService.updateCategory(String(ownerB._id), String(businessB._id), category.id, {
          name: "Stolen Name",
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        serviceService.updateCategory(String(ownerB._id), String(businessB._id), category.id, {
          active: true,
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("reactivates an archived category — same id, no Service reassignment, and it becomes selectable again", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id), "Hair");
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id }),
      );

      await serviceService.updateCategory(String(user._id), String(business._id), category.id, {
        active: false,
      });
      // Archived is invisible to the plain active-only query ServiceForm's picker uses...
      expect(
        await serviceService.listCategories(String(user._id), String(business._id), false),
      ).toHaveLength(0);
      // ...but discoverable in the Owner management context via includeInactive.
      const archivedList = await serviceService.listCategories(
        String(user._id),
        String(business._id),
        true,
      );
      expect(archivedList).toHaveLength(1);
      expect(archivedList[0]?.active).toBe(false);

      const reactivated = await serviceService.updateCategory(
        String(user._id),
        String(business._id),
        category.id,
        { active: true },
      );
      expect(reactivated.id).toBe(category.id);
      expect(reactivated.active).toBe(true);

      // Same id — the pre-existing Service's link is untouched, never reassigned/duplicated.
      const fetched = await serviceService.getService(
        String(user._id),
        String(business._id),
        service.id,
      );
      expect(fetched.serviceCategoryId).toBe(category.id);

      // Selectable for a NEW Service again through the normal active-category query.
      const activeAgain = await serviceService.listCategories(
        String(user._id),
        String(business._id),
        false,
      );
      expect(activeAgain.map((c) => c.id)).toContain(category.id);
      await expect(
        serviceService.createService(
          String(user._id),
          String(business._id),
          fixedServiceBody({ serviceCategoryId: category.id, name: "Second Service" }),
        ),
      ).resolves.toMatchObject({ serviceCategoryId: category.id });
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

    it("blocks archiving a Package Deal Service with outstanding (unused, unvoided) Package entitlements", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({
          serviceCategoryId: category.id,
          isPackageDeal: true,
          pricingMode: undefined,
          fixedPricing: undefined,
          packageServicesName: "Deep Tissue Massage",
          packagePricing: {
            durationMin: 60,
            sessionsInPackage: 5,
            bundlePriceCents: 45_000,
            discountPercent: 10,
          },
        }),
      );

      const entitlement = await PackageProgressModel.create({
        _id: new mongoose.Types.ObjectId(),
        businessId: business._id,
        customerUserId: new mongoose.Types.ObjectId(),
        businessClientId: new mongoose.Types.ObjectId(),
        serviceId: service.id,
        totalSessions: 5,
        remainingSessions: 4,
        completedSessions: 0,
        sessions: [],
        originBookingId: new mongoose.Types.ObjectId(),
        purchaseSnapshot: {
          name: service.name,
          packageServicesName: "Deep Tissue Massage",
          bundlePriceCents: 45_000,
          durationMin: 60,
          sessionsInPackage: 5,
          discountPercent: 10,
        },
      });

      await expect(
        serviceService.archiveService(String(user._id), String(business._id), service.id),
      ).rejects.toMatchObject({ statusCode: 409 });

      // Once the entitlement is fully depleted, archiving is no longer blocked.
      await PackageProgressModel.updateOne(
        { _id: entitlement._id },
        { $set: { remainingSessions: 0 } },
      ).exec();
      await serviceService.archiveService(String(user._id), String(business._id), service.id);
      const archived = await ServiceModel.findById(service.id).orFail().exec();
      expect(archived.status).toBe("ARCHIVED");
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

  // --- Restore validation (bug fix: restore must reuse the same ACTIVE/INACTIVE publish
  // validation create/update already enforce, never bypass it) ------------------------------

  describe("Restore validation reuses the existing ACTIVE/INACTIVE publish validation", () => {
    const draftBody = (overrides: Record<string, unknown> = {}) =>
      ({
        status: "DRAFT",
        isFeatured: false,
        isPackageDeal: false,
        name: "Incomplete Draft",
        scheduleMode: "AUTO",
        servedCities: [],
        assignedStaffMembershipIds: [],
        ...overrides,
      }) as unknown as CreateServiceBody;

    it("a valid archived Service restores successfully (unchanged happy path)", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-restore-ok@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id }),
      );
      await serviceService.archiveService(String(user._id), String(business._id), service.id);

      const restored = await serviceService.restoreService(
        String(user._id),
        String(business._id),
        service.id,
        "ACTIVE",
      );
      expect(restored.status).toBe("ACTIVE");
    });

    it("an archived incomplete Service (archived while still an incomplete DRAFT) cannot become ACTIVE through restore", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-restore-draft@example.com",
        "Salon A",
      );
      const draft = await serviceService.createService(
        String(user._id),
        String(business._id),
        draftBody(),
      );
      expect(draft.status).toBe("DRAFT");
      await serviceService.archiveService(String(user._id), String(business._id), draft.id);

      await expect(
        serviceService.restoreService(String(user._id), String(business._id), draft.id, "ACTIVE"),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        serviceService.restoreService(String(user._id), String(business._id), draft.id, "INACTIVE"),
      ).rejects.toMatchObject({ statusCode: 409 });

      // No partial mutation — the Service is exactly as it was, still ARCHIVED.
      const untouched = await ServiceModel.findById(draft.id).orFail().exec();
      expect(untouched.status).toBe("ARCHIVED");
      expect(untouched.archivedAt).toBeTruthy();
    });

    it("restore is rejected when the Service's category was deactivated while it sat archived (same validation create/update already enforce)", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-restore-category@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id }),
      );
      await serviceService.archiveService(String(user._id), String(business._id), service.id);
      await serviceCategoryRepository.updateById(business._id, category.id, { active: false });

      await expect(
        serviceService.restoreService(String(user._id), String(business._id), service.id, "ACTIVE"),
      ).rejects.toMatchObject({ statusCode: 404 });

      const untouched = await ServiceModel.findById(service.id).orFail().exec();
      expect(untouched.status).toBe("ARCHIVED");
    });

    it("restore is rejected when the persisted pricing configuration is inconsistent (same schema rule create/update already enforce)", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-restore-pricing@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id }),
      );
      await serviceService.archiveService(String(user._id), String(business._id), service.id);
      // Corrupt the persisted document directly (bypassing the service layer, which would
      // itself reject this) to simulate data that went stale while archived: pricingMode stays
      // FIXED but the required fixedPricing block is gone.
      await ServiceModel.updateOne(
        { _id: service.id, businessId: business._id },
        { $unset: { fixedPricing: "" } },
      ).exec();

      await expect(
        serviceService.restoreService(String(user._id), String(business._id), service.id, "ACTIVE"),
      ).rejects.toMatchObject({ statusCode: 409 });

      const untouched = await ServiceModel.findById(service.id).orFail().exec();
      expect(untouched.status).toBe("ARCHIVED");
      expect(untouched.fixedPricing).toBeUndefined();
    });

    it("a Package Deal Service missing a required ACTIVE field is rejected on restore", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-restore-package@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({
          serviceCategoryId: category.id,
          isPackageDeal: true,
          pricingMode: undefined,
          fixedPricing: undefined,
          packageServicesName: "Deep Tissue Massage",
          packagePricing: {
            durationMin: 60,
            sessionsInPackage: 5,
            bundlePriceCents: 45_000,
            discountPercent: 10,
          },
        }),
      );
      await serviceService.archiveService(String(user._id), String(business._id), service.id);
      // No outstanding Package entitlements exist for this freshly-created Service, so
      // archiveService's own Package-entitlement guard (unrelated to this bug fix) does not
      // interfere — confirmed by the archive call above succeeding without throwing.
      await ServiceModel.updateOne(
        { _id: service.id, businessId: business._id },
        { $unset: { packageServicesName: "" } },
      ).exec();

      await expect(
        serviceService.restoreService(String(user._id), String(business._id), service.id, "ACTIVE"),
      ).rejects.toMatchObject({ statusCode: 409 });

      const untouched = await ServiceModel.findById(service.id).orFail().exec();
      expect(untouched.status).toBe("ARCHIVED");
    });

    it("restore succeeds once the Service was completed (via the existing Edit flow) before being archived", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-restore-fixed@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const draft = await serviceService.createService(
        String(user._id),
        String(business._id),
        draftBody(),
      );
      expect(draft.status).toBe("DRAFT");

      // The Owner edits the still-DRAFT (not yet archived) Service into a complete, valid state
      // via the existing Edit flow. (updateService can also repair a Service AFTER it is
      // archived — see the "Archived Service edit (repair) flow" describe block below — this
      // test only exercises the pre-archive path.)
      const completed = await serviceService.updateService(
        String(user._id),
        String(business._id),
        draft.id,
        fixedServiceBody({ serviceCategoryId: category.id }) as unknown as UpdateServiceBody,
      );
      expect(completed.status).toBe("ACTIVE");

      await serviceService.archiveService(String(user._id), String(business._id), draft.id);
      const restored = await serviceService.restoreService(
        String(user._id),
        String(business._id),
        draft.id,
        "ACTIVE",
      );
      expect(restored.status).toBe("ACTIVE");
    });

    it("restore authorization is unchanged — a different Business's owner cannot restore this Service", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-restore-auth-a@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id }),
      );
      await serviceService.archiveService(String(user._id), String(business._id), service.id);

      const { user: otherOwner } = await createBusinessOwner(
        "owner-restore-auth-b@example.com",
        "Salon B",
      );

      await expect(
        serviceService.restoreService(
          String(otherOwner._id),
          String(business._id),
          service.id,
          "ACTIVE",
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      const untouched = await ServiceModel.findById(service.id).orFail().exec();
      expect(untouched.status).toBe("ARCHIVED");
    });
  });

  // --- Archived Service edit (repair) flow ---------------------------------------------------
  // Fixes the dead-end the Restore Validation fix exposed: updateService used to reject any
  // ARCHIVED Service outright (SERVICE_NOT_FOUND), so a Service archived while incomplete could
  // never be repaired. Editing an ARCHIVED Service is a repair flow only — it must never change
  // status itself; only the separate, explicit restoreService call may unarchive.

  describe("Archived Service edit (repair) flow", () => {
    const draftBody = (overrides: Record<string, unknown> = {}) =>
      ({
        status: "DRAFT",
        isFeatured: false,
        isPackageDeal: false,
        name: "Incomplete Draft",
        scheduleMode: "AUTO",
        servedCities: [],
        assignedStaffMembershipIds: [],
        ...overrides,
      }) as unknown as CreateServiceBody;

    it("the Owner can edit an ARCHIVED Service — update succeeds, status stays ARCHIVED, archivedAt unchanged", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-archedit-basic@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id }),
      );
      await serviceService.archiveService(String(user._id), String(business._id), service.id);
      const archivedAt = (await ServiceModel.findById(service.id).orFail().exec()).archivedAt;
      expect(archivedAt).toBeTruthy();

      const updated = await serviceService.updateService(
        String(user._id),
        String(business._id),
        service.id,
        fixedServiceBody({
          serviceCategoryId: category.id,
          name: "Deep Tissue Massage (renamed)",
        }) as unknown as UpdateServiceBody,
      );

      expect(updated.status).toBe("ARCHIVED");
      expect(updated.name).toBe("Deep Tissue Massage (renamed)");

      const persisted = await ServiceModel.findById(service.id).orFail().exec();
      expect(persisted.status).toBe("ARCHIVED");
      expect(persisted.archivedAt?.getTime()).toBe(archivedAt?.getTime());
    });

    it("the Owner can repair an incomplete archived Service with an intermediate DRAFT-tolerant save — succeeds, still ARCHIVED", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-archedit-repair@example.com",
        "Salon A",
      );
      const draft = await serviceService.createService(
        String(user._id),
        String(business._id),
        draftBody(),
      );
      await serviceService.archiveService(String(user._id), String(business._id), draft.id);

      // An intermediate repair save — still missing serviceCategoryId/subcategory/pricing — must
      // be accepted because status: "DRAFT" tolerates partial data, exactly like editing a
      // never-archived DRAFT Service already does.
      const repaired = await serviceService.updateService(
        String(user._id),
        String(business._id),
        draft.id,
        draftBody({ name: "Still incomplete, but renamed" }) as unknown as UpdateServiceBody,
      );

      expect(repaired.status).toBe("ARCHIVED");
      expect(repaired.name).toBe("Still incomplete, but renamed");
    });

    it("after fully repairing an archived Service, explicit restore succeeds using the existing (unmodified) restore validation", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-archedit-full-cycle@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const draft = await serviceService.createService(
        String(user._id),
        String(business._id),
        draftBody(),
      );
      await serviceService.archiveService(String(user._id), String(business._id), draft.id);

      // Restore is still correctly blocked before the repair.
      await expect(
        serviceService.restoreService(String(user._id), String(business._id), draft.id, "ACTIVE"),
      ).rejects.toMatchObject({ statusCode: 409 });

      await serviceService.updateService(
        String(user._id),
        String(business._id),
        draft.id,
        fixedServiceBody({ serviceCategoryId: category.id }) as unknown as UpdateServiceBody,
      );
      const stillArchived = await ServiceModel.findById(draft.id).orFail().exec();
      expect(stillArchived.status).toBe("ARCHIVED");

      const restored = await serviceService.restoreService(
        String(user._id),
        String(business._id),
        draft.id,
        "ACTIVE",
      );
      expect(restored.status).toBe("ACTIVE");
    });

    it("editing an ARCHIVED Service never auto-restores it, regardless of which status the Owner picks in the save button", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-archedit-no-autorestore@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id }),
      );
      await serviceService.archiveService(String(user._id), String(business._id), service.id);

      // A fully-valid edit body with status: "ACTIVE" (what the form's main Save button would
      // send) must still leave the Service ARCHIVED — only the separate restore action may
      // unarchive.
      const updated = await serviceService.updateService(
        String(user._id),
        String(business._id),
        service.id,
        fixedServiceBody({
          serviceCategoryId: category.id,
          status: "ACTIVE",
        }) as unknown as UpdateServiceBody,
      );
      expect(updated.status).toBe("ARCHIVED");
    });

    it("the edit payload cannot smuggle a status change away from ARCHIVED — status/archivedAt are immutable through edit", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-archedit-status-immutable@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id }),
      );
      await serviceService.archiveService(String(user._id), String(business._id), service.id);
      const archivedAt = (await ServiceModel.findById(service.id).orFail().exec()).archivedAt;

      for (const attemptedStatus of ["ACTIVE", "INACTIVE", "DRAFT"] as const) {
        await serviceService.updateService(
          String(user._id),
          String(business._id),
          service.id,
          (attemptedStatus === "DRAFT"
            ? draftBody({ status: attemptedStatus })
            : fixedServiceBody({
                serviceCategoryId: category.id,
                status: attemptedStatus,
              })) as unknown as UpdateServiceBody,
        );
        const persisted = await ServiceModel.findById(service.id).orFail().exec();
        expect(persisted.status).toBe("ARCHIVED");
        expect(persisted.archivedAt?.getTime()).toBe(archivedAt?.getTime());
      }
    });

    it("a different Business's Owner cannot edit this archived Service — existing authorization unchanged", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-archedit-auth-a@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id }),
      );
      await serviceService.archiveService(String(user._id), String(business._id), service.id);

      const { user: otherOwner } = await createBusinessOwner(
        "owner-archedit-auth-b@example.com",
        "Salon B",
      );

      await expect(
        serviceService.updateService(
          String(otherOwner._id),
          String(business._id),
          service.id,
          fixedServiceBody({ serviceCategoryId: category.id }) as unknown as UpdateServiceBody,
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      const untouched = await ServiceModel.findById(service.id).orFail().exec();
      expect(untouched.status).toBe("ARCHIVED");
    });

    it("an archived Package Deal Service can be repaired, stays ARCHIVED, and later restores once valid", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-archedit-package@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({
          serviceCategoryId: category.id,
          isPackageDeal: true,
          pricingMode: undefined,
          fixedPricing: undefined,
          packageServicesName: "Deep Tissue Massage",
          packagePricing: {
            durationMin: 60,
            sessionsInPackage: 5,
            bundlePriceCents: 45_000,
            discountPercent: 10,
          },
        }),
      );
      await serviceService.archiveService(String(user._id), String(business._id), service.id);
      await ServiceModel.updateOne(
        { _id: service.id, businessId: business._id },
        { $unset: { packageServicesName: "" } },
      ).exec();

      await expect(
        serviceService.restoreService(String(user._id), String(business._id), service.id, "ACTIVE"),
      ).rejects.toMatchObject({ statusCode: 409 });

      const repaired = await serviceService.updateService(
        String(user._id),
        String(business._id),
        service.id,
        fixedServiceBody({
          serviceCategoryId: category.id,
          isPackageDeal: true,
          pricingMode: undefined,
          fixedPricing: undefined,
          packageServicesName: "Deep Tissue Massage (repaired)",
          packagePricing: {
            durationMin: 60,
            sessionsInPackage: 5,
            bundlePriceCents: 45_000,
            discountPercent: 10,
          },
        }) as unknown as UpdateServiceBody,
      );
      expect(repaired.status).toBe("ARCHIVED");
      expect(repaired.packageServicesName).toBe("Deep Tissue Massage (repaired)");

      const restored = await serviceService.restoreService(
        String(user._id),
        String(business._id),
        service.id,
        "ACTIVE",
      );
      expect(restored.status).toBe("ACTIVE");
    });

    it("a repaired-but-still-archived Service does not appear in the default (non-archived) catalogue listing", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-archedit-catalog@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id }),
      );
      await serviceService.archiveService(String(user._id), String(business._id), service.id);
      await serviceService.updateService(
        String(user._id),
        String(business._id),
        service.id,
        fixedServiceBody({
          serviceCategoryId: category.id,
          name: "Repaired but archived",
        }) as unknown as UpdateServiceBody,
      );

      // The default catalogue query (no archivedOnly flag) — the same one the public/booking
      // surfaces and the normal Services list both rely on — must not surface it.
      const { services } = await serviceService.listServices(
        String(user._id),
        String(business._id),
        {},
      );
      expect(services.some((s) => s.id === service.id)).toBe(false);

      // Booking/Availability's own ARCHIVED-rejection (resolveServiceLines/validateResponsibleStaff
      // in booking.service.ts / booking-creation.service.ts, unmodified by this fix and already
      // covered by their own test suites) reads this exact persisted `status` field — proven
      // above to remain "ARCHIVED" after a repair edit, so that unrelated, pre-existing
      // rejection continues to apply without needing to be re-exercised here.
      const stillArchived = await ServiceModel.findById(service.id).orFail().exec();
      expect(stillArchived.status).toBe("ARCHIVED");
    });

    it("a failed repair edit (invalid staff reference) leaves every persisted field, status, and archivedAt unchanged", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-archedit-failed@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: category.id }),
      );
      await serviceService.archiveService(String(user._id), String(business._id), service.id);
      const before = await ServiceModel.findById(service.id).orFail().exec();

      await expect(
        serviceService.updateService(
          String(user._id),
          String(business._id),
          service.id,
          fixedServiceBody({
            serviceCategoryId: category.id,
            name: "Should not persist",
            assignedStaffMembershipIds: [String(new mongoose.Types.ObjectId())],
          }) as unknown as UpdateServiceBody,
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      const after = await ServiceModel.findById(service.id).orFail().exec();
      expect(after.name).toBe(before.name);
      expect(after.status).toBe("ARCHIVED");
      expect(after.archivedAt?.getTime()).toBe(before.archivedAt?.getTime());
    });
  });

  // --- Stale (inactive/removed) assigned-staff management --------------------------------------
  // Bug fix: a StaffMembership row is never hard-deleted (removal is soft — employmentActive
  // flips to false and removedAt is set, but the row and its id persist), yet
  // requireValidStaffMemberships previously only checked "does a row with this id exist for this
  // Business" — so a removed/deactivated staff id, once assigned, could never be validated away.
  // Combined with the Owner-facing Staff list excluding removed staff entirely, this made a
  // stale assignment impossible to see or remove. Fixed by (1) requireValidStaffMemberships also
  // rejecting any submitted id that is inactive/removed, and (2) ServiceForm.tsx now sourcing the
  // "currently assigned" display from the Service's own assignedStaff (which already correctly
  // resolves every persisted id, stale or not) instead of only the active Staff list.

  describe("Stale (inactive/removed) assigned-staff management", () => {
    it("Service management read already resolves a stale (now-inactive) assigned Staff member with their real name and employmentActive: false", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-stale-read@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const { membership: activeStaff } = await createStaffMember(
        business._id,
        "active@example.com",
      );
      const { membership: staleStaff } = await createStaffMember(business._id, "stale@example.com");
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({
          serviceCategoryId: category.id,
          assignedStaffMembershipIds: [String(activeStaff._id), String(staleStaff._id)],
        }),
      );

      // Deactivate (soft-remove) the staff AFTER assignment — never touches the Service itself.
      await staffRepository.softRemoveById(business._id, staleStaff._id);
      const untouchedService = await ServiceModel.findById(service.id).orFail().exec();
      expect(untouchedService.assignedStaffMembershipIds.map(String)).toEqual(
        [activeStaff._id, staleStaff._id].map(String),
      );

      const read = await serviceService.getService(
        String(user._id),
        String(business._id),
        service.id,
      );
      const staleEntry = read.assignedStaff.find((s) => s.membershipId === String(staleStaff._id));
      expect(staleEntry).toBeTruthy();
      expect(staleEntry?.employmentActive).toBe(false);
      expect(staleEntry?.name.length).toBeGreaterThan(0);
      const activeEntry = read.assignedStaff.find(
        (s) => s.membershipId === String(activeStaff._id),
      );
      expect(activeEntry?.employmentActive).toBe(true);
    });

    it("the Owner can remove a stale assignment and save — the update succeeds and the stale id is gone", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-stale-remove@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const { membership: activeStaff } = await createStaffMember(
        business._id,
        "active2@example.com",
      );
      const { membership: staleStaff } = await createStaffMember(
        business._id,
        "stale2@example.com",
      );
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({
          serviceCategoryId: category.id,
          assignedStaffMembershipIds: [String(activeStaff._id), String(staleStaff._id)],
        }),
      );
      await staffRepository.softRemoveById(business._id, staleStaff._id);

      const updated = await serviceService.updateService(
        String(user._id),
        String(business._id),
        service.id,
        fixedServiceBody({
          serviceCategoryId: category.id,
          assignedStaffMembershipIds: [String(activeStaff._id)],
        }) as unknown as UpdateServiceBody,
      );

      expect(updated.assignedStaff.map((s) => s.membershipId)).toEqual([String(activeStaff._id)]);
      const persisted = await ServiceModel.findById(service.id).orFail().exec();
      expect(persisted.assignedStaffMembershipIds.map(String)).toEqual([String(activeStaff._id)]);
    });

    it("retaining or newly submitting an inactive/removed Staff id is rejected — the Owner must actually remove it to save", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-stale-retain@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const { membership: activeStaff } = await createStaffMember(
        business._id,
        "active3@example.com",
      );
      const { membership: staleStaff } = await createStaffMember(
        business._id,
        "stale3@example.com",
      );
      const { membership: otherInactive } = await createStaffMember(
        business._id,
        "other-inactive@example.com",
      );
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({
          serviceCategoryId: category.id,
          assignedStaffMembershipIds: [String(activeStaff._id), String(staleStaff._id)],
        }),
      );
      await staffRepository.softRemoveById(business._id, staleStaff._id);
      await staffRepository.updateActiveById(business._id, otherInactive._id, {
        employmentActive: false,
      });

      // Retaining the already-assigned stale id.
      await expect(
        serviceService.updateService(
          String(user._id),
          String(business._id),
          service.id,
          fixedServiceBody({
            serviceCategoryId: category.id,
            assignedStaffMembershipIds: [String(activeStaff._id), String(staleStaff._id)],
          }) as unknown as UpdateServiceBody,
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      // Newly submitting a DIFFERENT, merely-deactivated (never previously assigned) staff id.
      await expect(
        serviceService.updateService(
          String(user._id),
          String(business._id),
          service.id,
          fixedServiceBody({
            serviceCategoryId: category.id,
            assignedStaffMembershipIds: [String(activeStaff._id), String(otherInactive._id)],
          }) as unknown as UpdateServiceBody,
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      // Nothing was mutated by either rejected attempt.
      const persisted = await ServiceModel.findById(service.id).orFail().exec();
      expect(persisted.assignedStaffMembershipIds.map(String)).toEqual(
        [activeStaff._id, staleStaff._id].map(String),
      );
    });

    it("a brand-new Service cannot be created with an inactive/removed Staff id", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-stale-create@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const { membership: inactiveStaff } = await createStaffMember(
        business._id,
        "inactive-create@example.com",
      );
      await staffRepository.softRemoveById(business._id, inactiveStaff._id);

      await expect(
        serviceService.createService(
          String(user._id),
          String(business._id),
          fixedServiceBody({
            serviceCategoryId: category.id,
            assignedStaffMembershipIds: [String(inactiveStaff._id)],
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(await ServiceModel.countDocuments({ businessId: business._id })).toBe(0);
    });

    it("a Package Deal Service's stale staff assignment can be repaired the same way, including while ARCHIVED", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-stale-package@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const { membership: activeStaff } = await createStaffMember(
        business._id,
        "active-pkg@example.com",
      );
      const { membership: staleStaff } = await createStaffMember(
        business._id,
        "stale-pkg@example.com",
      );
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({
          serviceCategoryId: category.id,
          isPackageDeal: true,
          pricingMode: undefined,
          fixedPricing: undefined,
          packageServicesName: "Deep Tissue Massage",
          packagePricing: {
            durationMin: 60,
            sessionsInPackage: 5,
            bundlePriceCents: 45_000,
            discountPercent: 10,
          },
          assignedStaffMembershipIds: [String(activeStaff._id), String(staleStaff._id)],
        }),
      );
      await staffRepository.softRemoveById(business._id, staleStaff._id);
      await serviceService.archiveService(String(user._id), String(business._id), service.id);

      const repaired = await serviceService.updateService(
        String(user._id),
        String(business._id),
        service.id,
        fixedServiceBody({
          serviceCategoryId: category.id,
          isPackageDeal: true,
          pricingMode: undefined,
          fixedPricing: undefined,
          packageServicesName: "Deep Tissue Massage",
          packagePricing: {
            durationMin: 60,
            sessionsInPackage: 5,
            bundlePriceCents: 45_000,
            discountPercent: 10,
          },
          assignedStaffMembershipIds: [String(activeStaff._id)],
        }) as unknown as UpdateServiceBody,
      );

      expect(repaired.status).toBe("ARCHIVED");
      expect(repaired.assignedStaff.map((s) => s.membershipId)).toEqual([String(activeStaff._id)]);
    });

    it("cross-business Staff ids remain rejected — a stale-assignment fix never widens business scoping", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-stale-cross-a@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const { business: otherBusiness } = await createBusinessOwner(
        "owner-stale-cross-b@example.com",
        "Salon B",
      );
      const { membership: staffOnOtherBusiness } = await createStaffMember(
        otherBusiness._id,
        "cross-business@example.com",
      );

      await expect(
        serviceService.createService(
          String(user._id),
          String(business._id),
          fixedServiceBody({
            serviceCategoryId: category.id,
            assignedStaffMembershipIds: [String(staffOnOtherBusiness._id)],
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("no automatic cascade: deactivating/removing a Staff member never mutates the Services that reference it", async () => {
      const { user, business } = await createBusinessOwner(
        "owner-stale-nocascade@example.com",
        "Salon A",
      );
      const category = await createCategory(String(user._id), String(business._id));
      const { membership: staff } = await createStaffMember(business._id, "nocascade@example.com");
      const service = await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({
          serviceCategoryId: category.id,
          assignedStaffMembershipIds: [String(staff._id)],
        }),
      );
      const before = await ServiceModel.findById(service.id).orFail().exec();

      await staffRepository.softRemoveById(business._id, staff._id);

      const after = await ServiceModel.findById(service.id).orFail().exec();
      expect(after.assignedStaffMembershipIds.map(String)).toEqual(
        before.assignedStaffMembershipIds.map(String),
      );
      expect(after.status).toBe(before.status);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
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

  // --- Category lookup batching (item 10 — no N+1) --------------------------------------------

  describe("listServices category lookups are batched, not N+1", () => {
    it("issues exactly one batched category query regardless of how many distinct categories are referenced", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const categoryOne = await createCategory(String(user._id), String(business._id), "Hair");
      const categoryTwo = await createCategory(String(user._id), String(business._id), "Nails");
      const categoryThree = await createCategory(String(user._id), String(business._id), "Spa");

      await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: categoryOne.id, name: "Haircut" }),
      );
      await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: categoryTwo.id, name: "Manicure" }),
      );
      await serviceService.createService(
        String(user._id),
        String(business._id),
        fixedServiceBody({ serviceCategoryId: categoryThree.id, name: "Facial" }),
      );

      const findManyByIdsForBusinessSpy = vi.spyOn(
        serviceCategoryRepository,
        "findManyByIdsForBusiness",
      );
      const findByIdSpy = vi.spyOn(serviceCategoryRepository, "findById");

      const { services } = await serviceService.listServices(
        String(user._id),
        String(business._id),
        {},
      );

      expect(services).toHaveLength(3);
      expect(findManyByIdsForBusinessSpy).toHaveBeenCalledTimes(1);
      // The batched call receives all three distinct category ids in one query — never one
      // findById call per Service, regardless of how many distinct categories are involved.
      expect(findByIdSpy).not.toHaveBeenCalled();

      findManyByIdsForBusinessSpy.mockRestore();
      findByIdSpy.mockRestore();
    });
  });

  // --- Index quality (item 14) ---------------------------------------------------------------

  describe("listByBusinessId query plan", () => {
    const createThreeServices = async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(String(user._id), String(business._id));
      for (let index = 0; index < 3; index += 1) {
        await serviceService.createService(
          String(user._id),
          String(business._id),
          fixedServiceBody({ serviceCategoryId: category.id, name: `Service ${index}` }),
        );
      }
      return { user, business };
    };

    const explainStages = async (query: Record<string, unknown>) => {
      const explanation = (await ServiceModel.find(query)
        .sort({ createdAt: -1 })
        .explain("executionStats")) as {
        executionStats?: { executionStages?: { stage?: string; inputStage?: { stage?: string } } };
      };
      return [
        explanation.executionStats?.executionStages?.stage,
        explanation.executionStats?.executionStages?.inputStage?.stage,
      ];
    };

    it("an explicit status equality query (e.g. status: 'ACTIVE') fully avoids both a collection scan and an in-memory sort", async () => {
      const { business } = await createThreeServices();

      const stages = await explainStages({ businessId: business._id, status: "ACTIVE" });
      expect(stages).not.toContain("COLLSCAN");
      expect(stages).not.toContain("SORT");
    });

    it("the default (exclude-ARCHIVED, $ne) list query avoids a collection scan — the index still bounds the scan to this Business's own Services, never the whole collection", async () => {
      const { business } = await createThreeServices();

      // NOTE: $ne on the index's middle field (status) means MongoDB cannot use the trailing
      // createdAt key to avoid an in-memory sort here (a $ne predicate spans multiple
      // disjoint index sub-ranges, which a single compound-index scan cannot deliver in one
      // sorted pass) — only the collection-scan elimination is guaranteed for this specific
      // query shape. See the index's own comment in service.model.ts for this same caveat.
      const stages = await explainStages({ businessId: business._id, status: { $ne: "ARCHIVED" } });
      expect(stages).not.toContain("COLLSCAN");
    });
  });
});
