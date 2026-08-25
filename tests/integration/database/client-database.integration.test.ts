import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessClientModel } from "../../../src/modules/client/client.model.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { createClientRoute } from "../../../src/modules/client/client.route.js";
import type { CreateClientBody } from "../../../src/modules/client/client.schema.js";
import { ClientService } from "../../../src/modules/client/client.service.js";
import { ClientIdentityService } from "../../../src/modules/client/client-identity.service.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

type DbIndex = {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
};

const indexesFor = async () => (await BusinessClientModel.collection.indexes()) as DbIndex[];

const businessInput = (ownerUserId: Types.ObjectId, name: string) => ({
  ownerUserId,
  name,
  ownerName: "Blake Owner",
  email: `${name.toLowerCase().replace(/\s+/g, "")}@example.com`,
  phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
  visitType: "AT_BUSINESS_LOCATION" as const,
  address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
  briefDescription: "A great business",
  category: "Wellness",
  subcategories: ["Massage"],
});

const validClientBody = (overrides: Record<string, unknown> = {}) => ({
  firstName: "Maria",
  lastName: "Papadopoulou",
  email: "maria@example.com",
  phone: { countryCode: "+357", nationalNumber: "99123456" },
  address: {
    city: "Limassol",
    propertyType: "Apartment",
    area: "Mackenzie",
    streetName: "Emrou",
    streetNumber: "14",
  },
  ...overrides,
});

describe("database-backed BusinessClient integration", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let staffRepository: StaffRepository;
  let clientRepository: ClientRepository;
  let clientService: ClientService;
  let tokenService: TokenService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    staffRepository = new StaffRepository();
    clientRepository = new ClientRepository();
    clientService = new ClientService(
      clientRepository,
      businessRepository,
      staffRepository,
      userRepository,
      new ClientIdentityService(userRepository, clientRepository),
    );
    tokenService = new TokenService(new SessionRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const createBusinessOwner = async (email: string, businessName: string) => {
    const user = await userRepository.create({
      normalizedEmail: email,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const pending = await businessRepository.create(businessInput(user._id, businessName));
    // Batch 11 — Client management writes are now gated on Business approval status; every
    // fixture business in this file needs to be in good standing for these (pre-existing,
    // unrelated) Client tests to still exercise what they actually test.
    const business = await businessRepository.casUpdateStatus(
      pending._id,
      ["PENDING"],
      "APPROVED",
      {
        fromStatus: "PENDING",
        actorUserId: new Types.ObjectId(),
        changedAt: new Date(),
      },
    );
    return { user, business: business ?? pending };
  };

  const createSupervisor = async (businessId: Types.ObjectId, email: string) => {
    const user = await userRepository.create({
      normalizedEmail: email,
      passwordHash: "hash",
      role: "SUPERVISOR",
      status: "ACTIVE",
    });
    await staffRepository.create({
      userId: user._id,
      businessId,
      role: "SUPERVISOR",
      createdByUserId: new Types.ObjectId(),
    });
    return user;
  };

  /** A self-registered, fully verified Customer — the only kind that can ever be linked. */
  const createVerifiedCustomer = async (email: string, phoneE164: string) => {
    const user = await userRepository.create({
      normalizedEmail: email,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    });
    await userRepository.createProfile({
      userId: user._id,
      firstName: "Real",
      lastName: "Customer",
      gender: "female",
      phone: {
        countryCode: "+357",
        nationalNumber: phoneE164.replace("+357", ""),
        e164: phoneE164,
      },
    });
    return user;
  };

  const buildClientApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/businesses", createClientRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF" | "CUSTOMER",
  ) => `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  // --- Index invariants -------------------------------------------------------------

  it("enforces same-business duplicate prevention and one-Client-per-linked-Customer at the database level", async () => {
    const indexes = await indexesFor();
    const emailIndex = indexes.find(
      (index) =>
        index.key["businessId"] === 1 &&
        index.key["normalizedEmail"] === 1 &&
        Object.keys(index.key).length === 2,
    );
    const phoneIndex = indexes.find(
      (index) =>
        index.key["businessId"] === 1 &&
        index.key["phone.e164"] === 1 &&
        Object.keys(index.key).length === 2,
    );
    const linkedIndex = indexes.find(
      (index) => index.key["businessId"] === 1 && index.key["linkedUserId"] === 1,
    );

    expect(emailIndex?.unique).toBe(true);
    expect(phoneIndex?.unique).toBe(true);
    expect(linkedIndex?.unique).toBe(true);
    expect(linkedIndex?.partialFilterExpression).toEqual({ linkedUserId: { $exists: true } });
  });

  it("listByBusinessId's default (non-archived, unfiltered) query uses the {businessId,archivedAt,createdAt} index, not a collection scan (item 14)", async () => {
    const { business, user } = await createBusinessOwner("owner-a@example.com", "Salon A");

    for (let index = 0; index < 3; index += 1) {
      await clientRepository.create({
        businessId: business._id,
        createdByUserId: user._id,
        firstName: `Client${index}`,
        normalizedEmail: `client${index}@example.com`,
        phone: {
          countryCode: "+357",
          nationalNumber: `9911223${index}`,
          e164: `+3579911223${index}`,
        },
        address: {
          city: "Larnaca",
          propertyType: "Apartment",
          area: "Center",
          streetName: "Main",
          streetNumber: "1",
        },
        linkState: "UNLINKED",
      });
    }

    const explanation = (await BusinessClientModel.find({
      businessId: business._id,
      archivedAt: { $exists: false },
    })
      .sort({ createdAt: -1 })
      .explain("executionStats")) as {
      executionStats?: { executionStages?: { stage?: string; inputStage?: { stage?: string } } };
    };
    const stages = [
      explanation.executionStats?.executionStages?.stage,
      explanation.executionStats?.executionStages?.inputStage?.stage,
    ];
    expect(stages).not.toContain("COLLSCAN");
    // No separate in-memory SORT stage — the index itself already returns rows in the
    // required order (proving the trailing createdAt key is actually doing its job).
    expect(stages).not.toContain("SORT");

    const { clients, total } = await clientRepository.listByBusinessId(business._id, {
      archivedOnly: false,
      page: 1,
      limit: 20,
    });
    expect(total).toBe(3);
    expect(clients).toHaveLength(3);
  });

  // --- Creation & authorization ------------------------------------------------------

  it("allows the owner to create an unlinked Client", async () => {
    const { user: owner, business } = await createBusinessOwner("owner-a@example.com", "Salon A");
    const app = buildClientApp();

    const response = await request(app)
      .post(`/businesses/${business._id}/clients`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send(validClientBody());

    expect(response.status).toBe(201);
    expect(response.body.data.linkState).toBe("UNLINKED");
    expect(response.body.data.isIdentityEditable).toBe(true);
  });

  it("allows a Supervisor to create a Client for their own Business", async () => {
    const { business } = await createBusinessOwner("owner-a@example.com", "Salon A");
    const supervisor = await createSupervisor(business._id, "supervisor@example.com");
    const app = buildClientApp();

    const response = await request(app)
      .post(`/businesses/${business._id}/clients`)
      .set("Authorization", await bearerFor(supervisor._id, "SUPERVISOR"))
      .send(validClientBody());

    expect(response.status).toBe(201);
  });

  it("denies a Supervisor of a different Business, an unrelated Owner, STAFF, and CUSTOMER tokens", async () => {
    const { business: businessA } = await createBusinessOwner("owner-a@example.com", "Salon A");
    const { user: ownerB } = await createBusinessOwner("owner-b@example.com", "Salon B");
    const supervisorOfB = await createSupervisor(new Types.ObjectId(), "supervisor-b@example.com");
    const staffUser = await userRepository.create({
      normalizedEmail: "staffer@example.com",
      passwordHash: "hash",
      role: "STAFF",
      status: "ACTIVE",
    });
    const customerUser = await userRepository.create({
      normalizedEmail: "shopper@example.com",
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    const app = buildClientApp();

    const asUnrelatedOwner = await request(app)
      .post(`/businesses/${businessA._id}/clients`)
      .set("Authorization", await bearerFor(ownerB._id, "BUSINESS_OWNER"))
      .send(validClientBody());
    expect(asUnrelatedOwner.status).toBe(404);

    const asCrossBusinessSupervisor = await request(app)
      .post(`/businesses/${businessA._id}/clients`)
      .set("Authorization", await bearerFor(supervisorOfB._id, "SUPERVISOR"))
      .send(validClientBody());
    expect(asCrossBusinessSupervisor.status).toBe(404);

    // STAFF and CUSTOMER are rejected by the route-level role gate itself (403), before the
    // request ever reaches ClientService — no STAFF Client permissions exist anywhere.
    const asStaff = await request(app)
      .post(`/businesses/${businessA._id}/clients`)
      .set("Authorization", await bearerFor(staffUser._id, "STAFF"))
      .send(validClientBody());
    expect(asStaff.status).toBe(403);

    const asCustomer = await request(app)
      .post(`/businesses/${businessA._id}/clients`)
      .set("Authorization", await bearerFor(customerUser._id, "CUSTOMER"))
      .send(validClientBody());
    expect(asCustomer.status).toBe(403);

    expect(await BusinessClientModel.countDocuments()).toBe(0);
  });

  it("rejects a duplicate email or phone within the same Business, but allows the same person across two Businesses", async () => {
    const { user: owner, business: businessA } = await createBusinessOwner(
      "owner-a@example.com",
      "Salon A",
    );
    const { user: ownerB, business: businessB } = await createBusinessOwner(
      "owner-b@example.com",
      "Salon B",
    );
    const app = buildClientApp();
    const tokenA = await bearerFor(owner._id, "BUSINESS_OWNER");

    const first = await request(app)
      .post(`/businesses/${businessA._id}/clients`)
      .set("Authorization", tokenA)
      .send(validClientBody());
    expect(first.status).toBe(201);

    const duplicateEmail = await request(app)
      .post(`/businesses/${businessA._id}/clients`)
      .set("Authorization", tokenA)
      .send(validClientBody({ phone: { countryCode: "+357", nationalNumber: "99999999" } }));
    expect(duplicateEmail.status).toBe(409);
    expect(duplicateEmail.body.errors[0].code).toBe("CLIENT_DUPLICATE_EMAIL");

    const duplicatePhone = await request(app)
      .post(`/businesses/${businessA._id}/clients`)
      .set("Authorization", tokenA)
      .send(validClientBody({ email: "different@example.com" }));
    expect(duplicatePhone.status).toBe(409);
    expect(duplicatePhone.body.errors[0].code).toBe("CLIENT_DUPLICATE_PHONE");

    // Cross-Business duplication of the SAME contact info is explicitly allowed.
    const sameSalonB = await request(app)
      .post(`/businesses/${businessB._id}/clients`)
      .set("Authorization", await bearerFor(ownerB._id, "BUSINESS_OWNER"))
      .send(validClientBody());
    expect(sameSalonB.status).toBe(201);

    expect(await BusinessClientModel.countDocuments()).toBe(2);
  });

  it("blocks two concurrent creates of the same contact info within one Business — only one succeeds", async () => {
    const { user: owner, business } = await createBusinessOwner("owner-a@example.com", "Salon A");
    const app = buildClientApp();
    const token = await bearerFor(owner._id, "BUSINESS_OWNER");

    const [first, second] = await Promise.all([
      request(app)
        .post(`/businesses/${business._id}/clients`)
        .set("Authorization", token)
        .send(validClientBody()),
      request(app)
        .post(`/businesses/${business._id}/clients`)
        .set("Authorization", token)
        .send(validClientBody()),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(await BusinessClientModel.countDocuments({ businessId: business._id })).toBe(1);
  });

  // --- Identity linking at creation time ----------------------------------------------

  it("links when email AND phone both match the same verified Customer", async () => {
    const { user: owner, business } = await createBusinessOwner("owner-a@example.com", "Salon A");
    await createVerifiedCustomer("maria@example.com", "+35799123456");
    const app = buildClientApp();

    const response = await request(app)
      .post(`/businesses/${business._id}/clients`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send(validClientBody());

    expect(response.status).toBe(201);
    expect(response.body.data.linkState).toBe("LINKED");
    expect(response.body.data.isIdentityEditable).toBe(false);
    // Overlays the live Customer identity rather than the locally-submitted snapshot.
    expect(response.body.data.firstName).toBe("Real");
  });

  it("never auto-links on a partial or crossed match — email-only, phone-only, and email->A/phone->B", async () => {
    const { user: owner, business } = await createBusinessOwner("owner-a@example.com", "Salon A");
    // Distinct pre-verified Customers, one per sub-case below — each Client body below must
    // also use a distinct email/phone of its own, since same-business duplicate prevention
    // (see the dedicated dedup test) would otherwise reject the second/third POST outright.
    await createVerifiedCustomer("cross-email@example.com", "+35799000001");
    await createVerifiedCustomer("cross-phone@example.com", "+35799000002");
    await createVerifiedCustomer("email-only@example.com", "+35799000003");
    await createVerifiedCustomer("phone-only@example.com", "+35799000004");
    const app = buildClientApp();
    const token = await bearerFor(owner._id, "BUSINESS_OWNER");

    // Email matches one verified Customer, phone matches a DIFFERENT one — crossed match.
    const crossed = await request(app)
      .post(`/businesses/${business._id}/clients`)
      .set("Authorization", token)
      .send(
        validClientBody({
          email: "cross-email@example.com",
          phone: { countryCode: "+357", nationalNumber: "99000002" },
        }),
      );
    expect(crossed.body.data.linkState).toBe("IDENTITY_CONFLICT");
    expect(crossed.body.data.linkedUserId).toBeUndefined();

    // Email matches, phone matches nobody.
    const emailOnly = await request(app)
      .post(`/businesses/${business._id}/clients`)
      .set("Authorization", token)
      .send(
        validClientBody({
          email: "email-only@example.com",
          phone: { countryCode: "+357", nationalNumber: "91000000" },
        }),
      );
    expect(emailOnly.body.data.linkState).toBe("IDENTITY_CONFLICT");

    // Phone matches, email matches nobody.
    const phoneOnly = await request(app)
      .post(`/businesses/${business._id}/clients`)
      .set("Authorization", token)
      .send(
        validClientBody({
          email: "nobody-else@example.com",
          phone: { countryCode: "+357", nationalNumber: "99000004" },
        }),
      );
    expect(phoneOnly.body.data.linkState).toBe("IDENTITY_CONFLICT");
  });

  // --- Editing: identity lock once linked --------------------------------------------

  it("rejects identity-field edits once LINKED, but keeps business-specific fields editable", async () => {
    const { user: owner, business } = await createBusinessOwner("owner-a@example.com", "Salon A");
    await createVerifiedCustomer("maria@example.com", "+35799123456");
    const app = buildClientApp();
    const token = await bearerFor(owner._id, "BUSINESS_OWNER");

    const created = await request(app)
      .post(`/businesses/${business._id}/clients`)
      .set("Authorization", token)
      .send(validClientBody());
    expect(created.body.data.linkState).toBe("LINKED");
    const clientId = created.body.data.id;

    const identityEdit = await request(app)
      .patch(`/businesses/${business._id}/clients/${clientId}`)
      .set("Authorization", token)
      .send({ firstName: "Someone Else" });
    expect(identityEdit.status).toBe(409);
    expect(identityEdit.body.errors[0].code).toBe("CLIENT_IDENTITY_LOCKED");

    const businessFieldEdit = await request(app)
      .patch(`/businesses/${business._id}/clients/${clientId}`)
      .set("Authorization", token)
      .send({ notes: "Prefers organic products", tag: "VIP" });
    expect(businessFieldEdit.status).toBe(200);
    expect(businessFieldEdit.body.data.notes).toBe("Prefers organic products");
    expect(businessFieldEdit.body.data.tag).toBe("VIP");
    // Identity still comes from the live Customer, unaffected by the edit above.
    expect(businessFieldEdit.body.data.firstName).toBe("Real");
  });

  it("allows local contact edits on an UNLINKED Client, and re-evaluates matching afterwards", async () => {
    const { user: owner, business } = await createBusinessOwner("owner-a@example.com", "Salon A");
    await createVerifiedCustomer("maria@example.com", "+35799123456");
    const app = buildClientApp();
    const token = await bearerFor(owner._id, "BUSINESS_OWNER");

    // Neither email nor phone matches the verified Customer above — genuinely UNLINKED.
    const created = await request(app)
      .post(`/businesses/${business._id}/clients`)
      .set("Authorization", token)
      .send(
        validClientBody({
          email: "walk-in@example.com",
          phone: { countryCode: "+357", nationalNumber: "90000000" },
        }),
      );
    expect(created.body.data.linkState).toBe("UNLINKED");
    const clientId = created.body.data.id;

    // Editing BOTH signals to match re-triggers matching and completes the link.
    const relinked = await request(app)
      .patch(`/businesses/${business._id}/clients/${clientId}`)
      .set("Authorization", token)
      .send({
        email: "maria@example.com",
        phone: { countryCode: "+357", nationalNumber: "99123456" },
      });

    expect(relinked.status).toBe(200);
    expect(relinked.body.data.linkState).toBe("LINKED");
  });

  // --- Archive / restore ---------------------------------------------------------------

  it("soft-archives, excludes archived Clients from the default list, and restores without touching linkState", async () => {
    const { user: owner, business } = await createBusinessOwner("owner-a@example.com", "Salon A");
    await createVerifiedCustomer("maria@example.com", "+35799123456");
    const app = buildClientApp();
    const token = await bearerFor(owner._id, "BUSINESS_OWNER");

    const created = await request(app)
      .post(`/businesses/${business._id}/clients`)
      .set("Authorization", token)
      .send(validClientBody());
    const clientId = created.body.data.id;
    expect(created.body.data.linkState).toBe("LINKED");

    const archived = await request(app)
      .delete(`/businesses/${business._id}/clients/${clientId}`)
      .set("Authorization", token);
    expect(archived.status).toBe(200);

    const doubleArchive = await request(app)
      .delete(`/businesses/${business._id}/clients/${clientId}`)
      .set("Authorization", token);
    expect(doubleArchive.status).toBe(409);

    const defaultList = await request(app)
      .get(`/businesses/${business._id}/clients`)
      .set("Authorization", token);
    expect(defaultList.body.data.clients).toHaveLength(0);

    const archivedList = await request(app)
      .get(`/businesses/${business._id}/clients?archived=true`)
      .set("Authorization", token);
    expect(archivedList.body.data.clients).toHaveLength(1);

    // An archived Client cannot be edited until restored.
    const editWhileArchived = await request(app)
      .patch(`/businesses/${business._id}/clients/${clientId}`)
      .set("Authorization", token)
      .send({ notes: "should not apply" });
    expect(editWhileArchived.status).toBe(404);

    const restoreNotArchived = await request(app)
      .post(`/businesses/${business._id}/clients/000000000000000000000000/restore`)
      .set("Authorization", token);
    expect(restoreNotArchived.status).toBe(404);

    const restored = await request(app)
      .post(`/businesses/${business._id}/clients/${clientId}/restore`)
      .set("Authorization", token);
    expect(restored.status).toBe(200);
    expect(restored.body.data.archivedAt).toBeUndefined();
    // Restore never disturbs the identity link established before archiving.
    expect(restored.body.data.linkState).toBe("LINKED");

    const restoreAgain = await request(app)
      .post(`/businesses/${business._id}/clients/${clientId}/restore`)
      .set("Authorization", token);
    expect(restoreAgain.status).toBe(409);
  });

  // --- List: search, tag filter, stats -------------------------------------------------

  it("supports search by name/email/phone, tag filtering, and reports real Total/New-this-month stats", async () => {
    const { user: owner, business } = await createBusinessOwner("owner-a@example.com", "Salon A");
    const app = buildClientApp();
    const token = await bearerFor(owner._id, "BUSINESS_OWNER");

    await request(app)
      .post(`/businesses/${business._id}/clients`)
      .set("Authorization", token)
      .send(validClientBody({ tag: "VIP" }));
    await request(app)
      .post(`/businesses/${business._id}/clients`)
      .set("Authorization", token)
      .send(
        validClientBody({
          firstName: "Yiota",
          email: "yiota@example.com",
          phone: { countryCode: "+357", nationalNumber: "96901234" },
          tag: "Regular",
        }),
      );

    const searchByName = await request(app)
      .get(`/businesses/${business._id}/clients?q=yiota`)
      .set("Authorization", token);
    expect(searchByName.body.data.clients).toHaveLength(1);
    expect(searchByName.body.data.clients[0].firstName).toBe("Yiota");

    const tagFilter = await request(app)
      .get(`/businesses/${business._id}/clients?tag=VIP`)
      .set("Authorization", token);
    expect(tagFilter.body.data.clients).toHaveLength(1);
    expect(tagFilter.body.data.clients[0].tag).toBe("VIP");

    const list = await request(app)
      .get(`/businesses/${business._id}/clients`)
      .set("Authorization", token);
    expect(list.body.data.stats.totalClients).toBe(2);
    expect(list.body.data.stats.newThisMonth).toBe(2);
    expect(list.body.data.pagination).toMatchObject({ page: 1, limit: 20, total: 2 });
  });

  it("never leaks Business A's Clients to Business B, even via a direct GET by id", async () => {
    const { user: ownerA, business: businessA } = await createBusinessOwner(
      "owner-a@example.com",
      "Salon A",
    );
    const { user: ownerB, business: businessB } = await createBusinessOwner(
      "owner-b@example.com",
      "Salon B",
    );
    const app = buildClientApp();

    const created = await request(app)
      .post(`/businesses/${businessA._id}/clients`)
      .set("Authorization", await bearerFor(ownerA._id, "BUSINESS_OWNER"))
      .send(validClientBody());
    const clientId = created.body.data.id;

    const crossBusinessGet = await request(app)
      .get(`/businesses/${businessB._id}/clients/${clientId}`)
      .set("Authorization", await bearerFor(ownerB._id, "BUSINESS_OWNER"));
    expect(crossBusinessGet.status).toBe(404);

    const listForB = await request(app)
      .get(`/businesses/${businessB._id}/clients`)
      .set("Authorization", await bearerFor(ownerB._id, "BUSINESS_OWNER"));
    expect(listForB.body.data.clients).toHaveLength(0);
  });

  // --- Regression: this router must not intercept business.route.ts's own paths -------

  it("falls through cleanly for a path this router does not own (service-level sanity check)", async () => {
    const { user: owner, business } = await createBusinessOwner("owner-a@example.com", "Salon A");
    const app = buildClientApp();

    const response = await request(app)
      .get(`/businesses/${business._id}/services`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"));

    // No route in createClientRoute() matches this path, so Express's default 404 applies —
    // proof this router never swallows requests it doesn't own.
    expect(response.status).toBe(404);
  });

  // --- Service-level: one Customer can link to Clients of two different Businesses ----

  it("allows one Customer to link to matching Client rows in two different Businesses", async () => {
    const { user: ownerA, business: businessA } = await createBusinessOwner(
      "owner-a@example.com",
      "Salon A",
    );
    const { user: ownerB, business: businessB } = await createBusinessOwner(
      "owner-b@example.com",
      "Salon B",
    );

    // Both Clients are created UNLINKED (no verified Customer exists yet).
    const clientA = await clientService.createClient(
      String(ownerA._id),
      "BUSINESS_OWNER",
      String(businessA._id),
      validClientBody() as unknown as CreateClientBody,
    );
    const clientB = await clientService.createClient(
      String(ownerB._id),
      "BUSINESS_OWNER",
      String(businessB._id),
      validClientBody() as unknown as CreateClientBody,
    );
    expect(clientA.linkState).toBe("UNLINKED");
    expect(clientB.linkState).toBe("UNLINKED");

    const customer = await createVerifiedCustomer("maria@example.com", "+35799123456");
    await new ClientIdentityService(
      userRepository,
      clientRepository,
    ).linkEligibleClientsForNewCustomer({
      userId: customer._id,
      normalizedEmail: "maria@example.com",
      phoneE164: "+35799123456",
    });

    const relinkedA = await clientRepository.findById(businessA._id, clientA.id);
    const relinkedB = await clientRepository.findById(businessB._id, clientB.id);
    expect(relinkedA?.linkState).toBe("LINKED");
    expect(relinkedB?.linkState).toBe("LINKED");
    expect(String(relinkedA?.linkedUserId)).toBe(String(customer._id));
    expect(String(relinkedB?.linkedUserId)).toBe(String(customer._id));
  });

  it("linking an archived Client never restores it — the Business must restore explicitly", async () => {
    const { user: owner, business } = await createBusinessOwner("owner-a@example.com", "Salon A");
    const created = await clientService.createClient(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      validClientBody() as unknown as CreateClientBody,
    );
    await clientService.archiveClient(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      created.id,
    );

    const customer = await createVerifiedCustomer("maria@example.com", "+35799123456");
    await new ClientIdentityService(
      userRepository,
      clientRepository,
    ).linkEligibleClientsForNewCustomer({
      userId: customer._id,
      normalizedEmail: "maria@example.com",
      phoneE164: "+35799123456",
    });

    const reloaded = await clientRepository.findById(business._id, created.id);
    expect(reloaded?.linkState).toBe("LINKED");
    expect(reloaded?.archivedAt).toBeDefined();
  });
});
