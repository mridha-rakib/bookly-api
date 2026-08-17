import express from "express";
import mongoose, { type Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { AddonModel } from "../../../src/modules/addons/addon.model.js";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { createAddonsRoute } from "../../../src/modules/addons/addon.route.js";
import type { CreateAddonBody } from "../../../src/modules/addons/addon.schema.js";
import { AddonService } from "../../../src/modules/addons/addon.service.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../../../src/modules/auth/auth.middleware.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessAccessRepository } from "../../../src/modules/business/business-access.repository.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import type { ServiceStatus } from "../../../src/modules/services/service.types.js";
import { ServiceCategoryRepository } from "../../../src/modules/services/service-category.repository.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
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

describe("database-backed Add-on integration", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let businessAccessRepository: BusinessAccessRepository;
  let staffRepository: StaffRepository;
  let serviceRepository: ServiceRepository;
  let serviceCategoryRepository: ServiceCategoryRepository;
  let addonRepository: AddonRepository;
  let addonServiceAssignmentRepository: AddonServiceAssignmentRepository;
  let addonService: AddonService;
  let tokenService: TokenService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    businessAccessRepository = new BusinessAccessRepository();
    staffRepository = new StaffRepository();
    serviceRepository = new ServiceRepository();
    serviceCategoryRepository = new ServiceCategoryRepository();
    addonRepository = new AddonRepository();
    addonServiceAssignmentRepository = new AddonServiceAssignmentRepository();
    addonService = new AddonService(
      addonRepository,
      addonServiceAssignmentRepository,
      businessRepository,
      serviceCategoryRepository,
      serviceRepository,
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

  const createCategory = async (businessId: Types.ObjectId, name = "Lashes") =>
    serviceCategoryRepository.create({ businessId, name, nameKey: name.trim().toLowerCase() });

  const createRealService = async (
    businessId: Types.ObjectId,
    name: string,
    status: ServiceStatus = "ACTIVE",
  ) =>
    serviceRepository.create({
      businessId,
      status,
      isFeatured: false,
      isPackageDeal: false,
      category: "Wellness & Beauty",
      name,
      sessionExpiryAlert: { enabled: false },
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities: [],
      assignedStaffMembershipIds: [],
    });

  const buildAddonsApp = () => {
    const app = express();
    app.use(express.json());
    app.use(
      createAuthenticateAccessTokenMiddleware(tokenService, userRepository),
      requireActiveUser(),
      requireRoles(["BUSINESS_OWNER"]),
    );
    app.use("/businesses", createAddonsRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF",
  ) => `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  const flatAddonBody = (overrides: Record<string, unknown> = {}): CreateAddonBody =>
    ({
      status: "ACTIVE",
      name: "False Lashes",
      priceCents: 1_050,
      ...overrides,
    }) as unknown as CreateAddonBody;

  // --- Authorization ------------------------------------------------------------------------

  describe("Authorization", () => {
    it("allows the owner to create and list Add-ons for their own Business", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(business._id);
      const service = await createRealService(business._id, "Bridal Make-up");

      await addonService.createAddon(
        String(user._id),
        String(business._id),
        flatAddonBody({
          customServiceCategoryId: String(category._id),
          assignedServiceIds: [String(service._id)],
        }),
      );

      const { addons, counts } = await addonService.listAddons(
        String(user._id),
        String(business._id),
        {},
      );
      expect(addons).toHaveLength(1);
      expect(counts.active).toBe(1);
    });

    it("denies another Business Owner from managing a Business they don't own", async () => {
      const { business: businessA } = await createBusinessOwner("owner-a@example.com", "Salon A");
      const { user: ownerB } = await createBusinessOwner("owner-b@example.com", "Salon B");

      await expect(
        addonService.listAddons(String(ownerB._id), String(businessA._id), {}),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("denies a BusinessAccess-linked (secondary) Business from managing Add-ons — owner-only", async () => {
      const { user: ownerA } = await createBusinessOwner("owner-a@example.com", "Salon A");
      const { business: businessB } = await createBusinessOwner("owner-b@example.com", "Salon B");
      await businessAccessRepository.create({ userId: ownerA._id, businessId: businessB._id });

      await expect(
        addonService.listAddons(String(ownerA._id), String(businessB._id), {}),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("rejects SUPERVISOR and STAFF at the real HTTP route boundary before reaching any handler", async () => {
      const { user: owner, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const { user: staffUser } = await createStaffMember(business._id, "staff@example.com");
      const app = buildAddonsApp();

      const supervisorResponse = await request(app)
        .get(`/businesses/${business._id}/addons`)
        .set("Authorization", await bearerFor(staffUser._id, "SUPERVISOR"));
      expect(supervisorResponse.status).toBe(403);

      const staffResponse = await request(app)
        .get(`/businesses/${business._id}/addons`)
        .set("Authorization", await bearerFor(staffUser._id, "STAFF"));
      expect(staffResponse.status).toBe(403);

      const ownerResponse = await request(app)
        .get(`/businesses/${business._id}/addons`)
        .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"));
      expect(ownerResponse.status).toBe(200);
    });

    it("rejects mass-assigned fields (businessId) at the real API boundary via strict schema", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(business._id);
      const service = await createRealService(business._id, "Bridal Make-up");
      const app = buildAddonsApp();
      const token = await bearerFor(user._id, "BUSINESS_OWNER");

      const response = await request(app)
        .post(`/businesses/${business._id}/addons`)
        .set("Authorization", token)
        .send({
          ...flatAddonBody({
            customServiceCategoryId: String(category._id),
            assignedServiceIds: [String(service._id)],
          }),
          businessId: "000000000000000000000000",
        });
      expect(response.status).toBe(400);
      expect(await AddonModel.countDocuments()).toBe(0);
    });
  });

  // --- Status lifecycle ----------------------------------------------------------------------

  describe("Status lifecycle (DRAFT / ACTIVE / INACTIVE / ARCHIVED)", () => {
    it("creates ACTIVE and INACTIVE Add-ons", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(business._id);
      const service = await createRealService(business._id, "Bridal Make-up");

      const active = await addonService.createAddon(
        String(user._id),
        String(business._id),
        flatAddonBody({
          customServiceCategoryId: String(category._id),
          assignedServiceIds: [String(service._id)],
        }),
      );
      const inactive = await addonService.createAddon(
        String(user._id),
        String(business._id),
        flatAddonBody({
          status: "INACTIVE",
          name: "Premium Foundation",
          customServiceCategoryId: String(category._id),
          assignedServiceIds: [String(service._id)],
        }),
      );

      expect(active.status).toBe("ACTIVE");
      expect(inactive.status).toBe("INACTIVE");
    });

    it("toggles status via the dedicated status endpoint", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(business._id);
      const service = await createRealService(business._id, "Bridal Make-up");
      const addon = await addonService.createAddon(
        String(user._id),
        String(business._id),
        flatAddonBody({
          customServiceCategoryId: String(category._id),
          assignedServiceIds: [String(service._id)],
        }),
      );

      const toggled = await addonService.updateAddonStatus(
        String(user._id),
        String(business._id),
        addon.id,
        "INACTIVE",
      );
      expect(toggled.status).toBe("INACTIVE");
    });

    it("archiving excludes an Add-on from the normal catalogue list but keeps the row in the database", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(business._id);
      const service = await createRealService(business._id, "Bridal Make-up");
      const addon = await addonService.createAddon(
        String(user._id),
        String(business._id),
        flatAddonBody({
          customServiceCategoryId: String(category._id),
          assignedServiceIds: [String(service._id)],
        }),
      );

      await addonService.archiveAddon(String(user._id), String(business._id), addon.id);

      const { addons, counts } = await addonService.listAddons(
        String(user._id),
        String(business._id),
        {},
      );
      expect(addons).toHaveLength(0);
      expect(counts.archived).toBe(1);
      expect(await AddonModel.countDocuments({ _id: addon.id })).toBe(1);

      const archivedList = await addonService.listAddons(String(user._id), String(business._id), {
        archivedOnly: true,
      });
      expect(archivedList.addons).toHaveLength(1);
      expect(archivedList.addons[0]?.status).toBe("ARCHIVED");
    });

    it("restores an archived Add-on explicitly as ACTIVE or INACTIVE — never automatically, never to DRAFT", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(business._id);
      const service = await createRealService(business._id, "Bridal Make-up");
      const addon = await addonService.createAddon(
        String(user._id),
        String(business._id),
        flatAddonBody({
          customServiceCategoryId: String(category._id),
          assignedServiceIds: [String(service._id)],
        }),
      );
      await addonService.archiveAddon(String(user._id), String(business._id), addon.id);

      const restoredInactive = await addonService.restoreAddon(
        String(user._id),
        String(business._id),
        addon.id,
        "INACTIVE",
      );
      expect(restoredInactive.status).toBe("INACTIVE");

      await addonService.archiveAddon(String(user._id), String(business._id), addon.id);
      const restoredActive = await addonService.restoreAddon(
        String(user._id),
        String(business._id),
        addon.id,
        "ACTIVE",
      );
      expect(restoredActive.status).toBe("ACTIVE");

      const app = buildAddonsApp();
      const token = await bearerFor(user._id, "BUSINESS_OWNER");
      await addonService.archiveAddon(String(user._id), String(business._id), addon.id);
      const draftRestoreResponse = await request(app)
        .post(`/businesses/${business._id}/addons/${addon.id}/restore`)
        .set("Authorization", token)
        .send({ status: "DRAFT" });
      expect(draftRestoreResponse.status).toBe(400);
    });

    it("rejects archiving an already-archived Add-on and restoring a non-archived Add-on", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(business._id);
      const service = await createRealService(business._id, "Bridal Make-up");
      const addon = await addonService.createAddon(
        String(user._id),
        String(business._id),
        flatAddonBody({
          customServiceCategoryId: String(category._id),
          assignedServiceIds: [String(service._id)],
        }),
      );

      await expect(
        addonService.restoreAddon(String(user._id), String(business._id), addon.id, "ACTIVE"),
      ).rejects.toMatchObject({ statusCode: 409 });

      await addonService.archiveAddon(String(user._id), String(business._id), addon.id);
      await expect(
        addonService.archiveAddon(String(user._id), String(business._id), addon.id),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  // --- Draft lifecycle -----------------------------------------------------------------------

  describe("Draft lifecycle", () => {
    it("creates a DRAFT Add-on with only a name — no price, category, or assigned services", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");

      const draft = await addonService.createAddon(String(user._id), String(business._id), {
        status: "DRAFT",
        name: "New Add-on",
      } as unknown as CreateAddonBody);

      expect(draft.status).toBe("DRAFT");
      expect(draft.priceCents).toBeUndefined();
      expect(draft.customServiceCategoryId).toBeUndefined();
      expect(draft.assignedServices).toHaveLength(0);
      expect(await AddonModel.countDocuments({ _id: draft.id })).toBe(1);
    });

    it("rejects a normal (non-draft) save missing required fields, at the schema boundary", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const app = buildAddonsApp();
      const token = await bearerFor(user._id, "BUSINESS_OWNER");

      const response = await request(app)
        .post(`/businesses/${business._id}/addons`)
        .set("Authorization", token)
        .send({ status: "ACTIVE", name: "Incomplete Add-on" });

      expect(response.status).toBe(400);
      expect(await AddonModel.countDocuments()).toBe(0);
    });

    it("publishes a DRAFT to ACTIVE once the payload is fully valid", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(business._id);
      const service = await createRealService(business._id, "Bridal Make-up");

      const draft = await addonService.createAddon(String(user._id), String(business._id), {
        status: "DRAFT",
        name: "New Add-on",
      } as unknown as CreateAddonBody);

      const published = await addonService.updateAddon(
        String(user._id),
        String(business._id),
        draft.id,
        flatAddonBody({
          customServiceCategoryId: String(category._id),
          assignedServiceIds: [String(service._id)],
        }),
      );

      expect(published.status).toBe("ACTIVE");
      expect(published.priceCents).toBe(1_050);
      expect(published.assignedServices).toHaveLength(1);
    });

    it("rejects the quick Active/Inactive toggle on a DRAFT Add-on", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const draft = await addonService.createAddon(String(user._id), String(business._id), {
        status: "DRAFT",
        name: "New Add-on",
      } as unknown as CreateAddonBody);

      await expect(
        addonService.updateAddonStatus(String(user._id), String(business._id), draft.id, "ACTIVE"),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  // --- Price -----------------------------------------------------------------------------------

  describe("Price (flat fee only, integer cents)", () => {
    it("persists priceCents as an integer, never a formatted string", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(business._id);
      const service = await createRealService(business._id, "Bridal Make-up");

      const addon = await addonService.createAddon(
        String(user._id),
        String(business._id),
        flatAddonBody({
          priceCents: 1_050,
          customServiceCategoryId: String(category._id),
          assignedServiceIds: [String(service._id)],
        }),
      );

      expect(addon.priceCents).toBe(1_050);
      expect(typeof addon.priceCents).toBe("number");
    });

    it("rejects a negative price and a non-integer price at the schema boundary", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(business._id);
      const service = await createRealService(business._id, "Bridal Make-up");
      const app = buildAddonsApp();
      const token = await bearerFor(user._id, "BUSINESS_OWNER");

      const negative = await request(app)
        .post(`/businesses/${business._id}/addons`)
        .set("Authorization", token)
        .send(
          flatAddonBody({
            priceCents: -100,
            customServiceCategoryId: String(category._id),
            assignedServiceIds: [String(service._id)],
          }),
        );
      expect(negative.status).toBe(400);

      const nonInteger = await request(app)
        .post(`/businesses/${business._id}/addons`)
        .set("Authorization", token)
        .send(
          flatAddonBody({
            priceCents: 10.5,
            customServiceCategoryId: String(category._id),
            assignedServiceIds: [String(service._id)],
          }),
        );
      expect(nonInteger.status).toBe(400);
    });
  });

  // --- Custom Service Category -----------------------------------------------------------------

  describe("Custom Service Category", () => {
    it("rejects creating an ACTIVE Add-on with a category from a different business", async () => {
      const { business: businessA } = await createBusinessOwner("owner-a@example.com", "Salon A");
      const { user: ownerB, business: businessB } = await createBusinessOwner(
        "owner-b@example.com",
        "Salon B",
      );
      const categoryOfA = await createCategory(businessA._id, "Hair Treatment");
      const service = await createRealService(businessB._id, "Party Makeup");

      await expect(
        addonService.createAddon(
          String(ownerB._id),
          String(businessB._id),
          flatAddonBody({
            customServiceCategoryId: String(categoryOfA._id),
            assignedServiceIds: [String(service._id)],
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("rejects an archived category for a new ACTIVE/INACTIVE Add-on", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(business._id);
      await serviceCategoryRepository.updateById(business._id, category._id, { active: false });
      const service = await createRealService(business._id, "Bridal Make-up");

      await expect(
        addonService.createAddon(
          String(user._id),
          String(business._id),
          flatAddonBody({
            customServiceCategoryId: String(category._id),
            assignedServiceIds: [String(service._id)],
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("keeps an archived category resolvable on an already-saved Add-on (historical reference)", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(business._id);
      const service = await createRealService(business._id, "Bridal Make-up");
      const addon = await addonService.createAddon(
        String(user._id),
        String(business._id),
        flatAddonBody({
          customServiceCategoryId: String(category._id),
          assignedServiceIds: [String(service._id)],
        }),
      );

      await serviceCategoryRepository.updateById(business._id, category._id, { active: false });

      const fetched = await addonService.getAddon(String(user._id), String(business._id), addon.id);
      expect(fetched.customServiceCategoryName).toBe("Lashes");
    });

    it("allows a DRAFT Add-on to remain without a category", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");

      const draft = await addonService.createAddon(String(user._id), String(business._id), {
        status: "DRAFT",
        name: "New Add-on",
      } as unknown as CreateAddonBody);

      expect(draft.customServiceCategoryId).toBeUndefined();
    });
  });

  // --- Service assignment (many-to-many) ---------------------------------------------------

  describe("Service assignment (many-to-many)", () => {
    it("attaches one Add-on to multiple Services and one Service to multiple Add-ons", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(business._id);
      const bridal = await createRealService(business._id, "Bridal Makeup");
      const wedding = await createRealService(business._id, "Wedding Makeup");
      const party = await createRealService(business._id, "Party Makeup");

      const lashes = await addonService.createAddon(
        String(user._id),
        String(business._id),
        flatAddonBody({
          name: "False Lashes",
          customServiceCategoryId: String(category._id),
          assignedServiceIds: [String(bridal._id), String(wedding._id), String(party._id)],
        }),
      );
      const foundation = await addonService.createAddon(
        String(user._id),
        String(business._id),
        flatAddonBody({
          name: "Premium Foundation",
          customServiceCategoryId: String(category._id),
          assignedServiceIds: [String(bridal._id)],
        }),
      );

      expect(lashes.assignedServices).toHaveLength(3);

      const assignedToBridal = await addonService.listAddonsForService(
        String(user._id),
        String(business._id),
        String(bridal._id),
      );
      expect(assignedToBridal.map((a) => a.addonId).sort()).toEqual(
        [lashes.id, foundation.id].sort(),
      );
    });

    it("rejects assigning an Add-on to a Service from a different business", async () => {
      const { business: businessA } = await createBusinessOwner("owner-a@example.com", "Salon A");
      const { user: ownerB, business: businessB } = await createBusinessOwner(
        "owner-b@example.com",
        "Salon B",
      );
      const category = await createCategory(businessB._id);
      const serviceOfA = await createRealService(businessA._id, "Bridal Makeup");

      await expect(
        addonService.createAddon(
          String(ownerB._id),
          String(businessB._id),
          flatAddonBody({
            customServiceCategoryId: String(category._id),
            assignedServiceIds: [String(serviceOfA._id)],
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("does not reject an assignment merely because the Service's category differs from the Add-on's category", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const lashesCategory = await createCategory(business._id, "Lashes");
      // The Service itself carries no serviceCategoryId link in this fixture — the point is
      // simply that Add-on category is never cross-checked against the Service at all.
      const hairService = await createRealService(business._id, "Haircut");

      const addon = await addonService.createAddon(
        String(user._id),
        String(business._id),
        flatAddonBody({
          customServiceCategoryId: String(lashesCategory._id),
          assignedServiceIds: [String(hairService._id)],
        }),
      );

      expect(addon.assignedServices).toHaveLength(1);
      expect(addon.assignedServices[0]?.serviceId).toBe(String(hairService._id));
    });

    it("rejects a brand-new assignment to an ARCHIVED Service, but preserves an existing one", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(business._id);
      const activeService = await createRealService(business._id, "Bridal Makeup", "ACTIVE");
      const archivedService = await createRealService(business._id, "Retired Service", "ARCHIVED");

      await expect(
        addonService.createAddon(
          String(user._id),
          String(business._id),
          flatAddonBody({
            customServiceCategoryId: String(category._id),
            assignedServiceIds: [String(archivedService._id)],
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      // Now create with a valid active service, archive that service afterwards, and confirm
      // a later save that keeps (doesn't add/remove) the assignment does not reject it.
      const addon = await addonService.createAddon(
        String(user._id),
        String(business._id),
        flatAddonBody({
          customServiceCategoryId: String(category._id),
          assignedServiceIds: [String(activeService._id)],
        }),
      );

      await serviceRepository.archiveById(business._id, activeService._id);

      const resaved = await addonService.updateAddon(
        String(user._id),
        String(business._id),
        addon.id,
        flatAddonBody({
          customServiceCategoryId: String(category._id),
          assignedServiceIds: [String(activeService._id)],
        }),
      );
      expect(resaved.assignedServices).toHaveLength(1);
      expect(resaved.assignedServices[0]?.status).toBe("ARCHIVED");
    });

    it("removes only the delta on update — unassigning one Service leaves the other intact", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(business._id);
      const bridal = await createRealService(business._id, "Bridal Makeup");
      const wedding = await createRealService(business._id, "Wedding Makeup");

      const addon = await addonService.createAddon(
        String(user._id),
        String(business._id),
        flatAddonBody({
          customServiceCategoryId: String(category._id),
          assignedServiceIds: [String(bridal._id), String(wedding._id)],
        }),
      );
      expect(addon.assignedServices).toHaveLength(2);

      const updated = await addonService.updateAddon(
        String(user._id),
        String(business._id),
        addon.id,
        flatAddonBody({
          customServiceCategoryId: String(category._id),
          assignedServiceIds: [String(bridal._id)],
        }),
      );

      expect(updated.assignedServices).toHaveLength(1);
      expect(updated.assignedServices[0]?.serviceId).toBe(String(bridal._id));
    });
  });

  // --- Regression: existing Service tests are unaffected --------------------------------------

  describe("Regression", () => {
    it("archiving a Service does not delete its Add-on assignment rows", async () => {
      const { user, business } = await createBusinessOwner("owner@example.com", "Salon A");
      const category = await createCategory(business._id);
      const service = await createRealService(business._id, "Bridal Makeup");
      const addon = await addonService.createAddon(
        String(user._id),
        String(business._id),
        flatAddonBody({
          customServiceCategoryId: String(category._id),
          assignedServiceIds: [String(service._id)],
        }),
      );

      await serviceRepository.archiveById(business._id, service._id);

      expect(
        await mongoose.connection
          .collection("addonserviceassignments")
          .countDocuments({ addonId: new mongoose.Types.ObjectId(addon.id) }),
      ).toBe(1);
    });
  });
});
