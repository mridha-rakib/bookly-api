import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { createPublicContentRoute } from "../../../src/modules/content/content.route.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { createSuperAdminRoute } from "../../../src/modules/super-admin/super-admin.route.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/**
 * Phase 1 — Content Manager FAQ vertical. Exercises the real routes end to end: the router-wide
 * `requireRoles(["SUPER_ADMIN"])` gate on `/super-admin/content/faqs`, zod `.strict()` validation,
 * the persisted `order` field + transactional reorder, and the genuinely-anonymous public
 * `/content/faqs` read that must never surface a DRAFT.
 */
describe("HTTP-level Content Manager FAQ (Phase 1)", () => {
  let userRepository: UserRepository;
  let tokenService: TokenService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    tokenService = new TokenService(new SessionRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/super-admin", createSuperAdminRoute());
    app.use("/content", createPublicContentRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const createUser = (role: "CUSTOMER" | "BUSINESS_OWNER" | "STAFF" | "SUPER_ADMIN") =>
    userRepository.create({
      normalizedEmail: `${role.toLowerCase()}-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role,
      status: "ACTIVE",
    });

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "CUSTOMER" | "BUSINESS_OWNER" | "STAFF" | "SUPER_ADMIN",
  ) => `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  const createFaq = async (app: express.Express, token: string, body: Record<string, unknown>) => {
    const response = await request(app)
      .post("/super-admin/content/faqs")
      .set("Authorization", token)
      .send(body);
    expect(response.status).toBe(201);
    return response.body.data as {
      id: string;
      question: string;
      answer: string;
      audience: string;
      status: string;
      order: number;
    };
  };

  // --- Authorization -------------------------------------------------------------------------

  it("rejects an unauthenticated create (401) and writes nothing", async () => {
    const app = buildApp();
    const response = await request(app)
      .post("/super-admin/content/faqs")
      .send({ question: "Q", answer: "A", audience: "CUSTOMER" });
    expect(response.status).toBe(401);

    const superAdmin = await createUser("SUPER_ADMIN");
    const list = await request(app)
      .get("/super-admin/content/faqs?audience=CUSTOMER")
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));
    expect(list.body.data.faqs).toHaveLength(0);
  });

  it.each(["CUSTOMER", "BUSINESS_OWNER", "STAFF"] as const)(
    "rejects a %s token on every FAQ mutation (403)",
    async (role) => {
      const app = buildApp();
      const user = await createUser(role);
      const token = await bearerFor(user._id, role);
      const fakeId = new Types.ObjectId().toString();

      const create = await request(app)
        .post("/super-admin/content/faqs")
        .set("Authorization", token)
        .send({ question: "Q", answer: "A", audience: "CUSTOMER" });
      const patch = await request(app)
        .patch(`/super-admin/content/faqs/${fakeId}`)
        .set("Authorization", token)
        .send({ question: "Q2" });
      const del = await request(app)
        .delete(`/super-admin/content/faqs/${fakeId}`)
        .set("Authorization", token);
      const reorder = await request(app)
        .post("/super-admin/content/faqs/reorder")
        .set("Authorization", token)
        .send({ audience: "CUSTOMER", orderedIds: [fakeId] });

      expect([create.status, patch.status, del.status, reorder.status]).toEqual([
        403, 403, 403, 403,
      ]);
    },
  );

  // --- CRUD persistence -------------------------------------------------------------------------

  it("SUPER_ADMIN creates Customer and Business FAQs; both persist and are audience-isolated", async () => {
    const app = buildApp();
    const superAdmin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(superAdmin._id, "SUPER_ADMIN");

    const cust = await createFaq(app, token, {
      question: "What is the deposit for?",
      answer: "It verifies your card.",
      audience: "CUSTOMER",
    });
    const biz = await createFaq(app, token, {
      question: "How do I set staff hours?",
      answer: "In the staff section.",
      audience: "BUSINESS",
    });

    expect(cust.status).toBe("PUBLISHED");
    expect(cust.order).toBe(0);
    expect(biz.order).toBe(0);

    const custList = await request(app)
      .get("/super-admin/content/faqs?audience=CUSTOMER")
      .set("Authorization", token);
    expect(custList.body.data.faqs.map((f: { id: string }) => f.id)).toEqual([cust.id]);

    const bizList = await request(app)
      .get("/super-admin/content/faqs?audience=BUSINESS")
      .set("Authorization", token);
    expect(bizList.body.data.faqs.map((f: { id: string }) => f.id)).toEqual([biz.id]);
  });

  it("edit persists the exact record through a fresh read", async () => {
    const app = buildApp();
    const superAdmin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(superAdmin._id, "SUPER_ADMIN");
    const faq = await createFaq(app, token, {
      question: "Original?",
      answer: "Original answer.",
      audience: "CUSTOMER",
    });

    const patch = await request(app)
      .patch(`/super-admin/content/faqs/${faq.id}`)
      .set("Authorization", token)
      .send({ question: "Edited?", answer: "Edited answer." });
    expect(patch.status).toBe(200);

    const list = await request(app)
      .get("/super-admin/content/faqs?audience=CUSTOMER")
      .set("Authorization", token);
    expect(list.body.data.faqs[0]).toMatchObject({
      id: faq.id,
      question: "Edited?",
      answer: "Edited answer.",
    });
  });

  it("delete persists — the row is gone after a fresh read; deleting again is 404", async () => {
    const app = buildApp();
    const superAdmin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(superAdmin._id, "SUPER_ADMIN");
    const faq = await createFaq(app, token, {
      question: "Delete me?",
      answer: "Yes.",
      audience: "CUSTOMER",
    });

    const del = await request(app)
      .delete(`/super-admin/content/faqs/${faq.id}`)
      .set("Authorization", token);
    expect(del.status).toBe(200);

    const list = await request(app)
      .get("/super-admin/content/faqs?audience=CUSTOMER")
      .set("Authorization", token);
    expect(list.body.data.faqs).toHaveLength(0);

    const delAgain = await request(app)
      .delete(`/super-admin/content/faqs/${faq.id}`)
      .set("Authorization", token);
    expect(delAgain.status).toBe(404);
  });

  // --- Reorder --------------------------------------------------------------------------------

  it("reorder persists a new order and does not touch the other audience", async () => {
    const app = buildApp();
    const superAdmin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(superAdmin._id, "SUPER_ADMIN");

    const a = await createFaq(app, token, { question: "A?", answer: "a", audience: "CUSTOMER" });
    const b = await createFaq(app, token, { question: "B?", answer: "b", audience: "CUSTOMER" });
    const c = await createFaq(app, token, { question: "C?", answer: "c", audience: "CUSTOMER" });
    const biz = await createFaq(app, token, { question: "Z?", answer: "z", audience: "BUSINESS" });

    const reorder = await request(app)
      .post("/super-admin/content/faqs/reorder")
      .set("Authorization", token)
      .send({ audience: "CUSTOMER", orderedIds: [c.id, a.id, b.id] });
    expect(reorder.status).toBe(200);

    const custList = await request(app)
      .get("/super-admin/content/faqs?audience=CUSTOMER")
      .set("Authorization", token);
    expect(
      custList.body.data.faqs.map((f: { id: string; order: number }) => [f.id, f.order]),
    ).toEqual([
      [c.id, 0],
      [a.id, 1],
      [b.id, 2],
    ]);

    const bizList = await request(app)
      .get("/super-admin/content/faqs?audience=BUSINESS")
      .set("Authorization", token);
    expect(bizList.body.data.faqs).toEqual([expect.objectContaining({ id: biz.id, order: 0 })]);
  });

  it("reorder rejects a partial / cross-audience id list (400) and leaves order untouched", async () => {
    const app = buildApp();
    const superAdmin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(superAdmin._id, "SUPER_ADMIN");

    const a = await createFaq(app, token, { question: "A?", answer: "a", audience: "CUSTOMER" });
    const b = await createFaq(app, token, { question: "B?", answer: "b", audience: "CUSTOMER" });
    const biz = await createFaq(app, token, { question: "Z?", answer: "z", audience: "BUSINESS" });

    const partial = await request(app)
      .post("/super-admin/content/faqs/reorder")
      .set("Authorization", token)
      .send({ audience: "CUSTOMER", orderedIds: [b.id] });
    expect(partial.status).toBe(400);

    const crossAudience = await request(app)
      .post("/super-admin/content/faqs/reorder")
      .set("Authorization", token)
      .send({ audience: "CUSTOMER", orderedIds: [a.id, biz.id] });
    expect(crossAudience.status).toBe(400);

    const list = await request(app)
      .get("/super-admin/content/faqs?audience=CUSTOMER")
      .set("Authorization", token);
    expect(list.body.data.faqs.map((f: { id: string }) => f.id)).toEqual([a.id, b.id]);
  });

  // --- Public read -------------------------------------------------------------------------

  it("public CUSTOMER endpoint returns only PUBLISHED Customer FAQs, ordered, no draft leak", async () => {
    const app = buildApp();
    const superAdmin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(superAdmin._id, "SUPER_ADMIN");

    const published = await createFaq(app, token, {
      question: "Published customer Q?",
      answer: "yes",
      audience: "CUSTOMER",
    });
    const draft = await createFaq(app, token, {
      question: "Draft customer Q?",
      answer: "hidden",
      audience: "CUSTOMER",
      status: "DRAFT",
    });
    await createFaq(app, token, {
      question: "Published business Q?",
      answer: "biz",
      audience: "BUSINESS",
    });

    const res = await request(app).get("/content/faqs?audience=CUSTOMER");
    expect(res.status).toBe(200);
    const faqs = res.body.data.faqs as Array<Record<string, unknown>>;
    expect(faqs).toEqual([{ id: published.id, question: "Published customer Q?", answer: "yes" }]);
    expect(JSON.stringify(res.body)).not.toContain(draft.id);
    expect(JSON.stringify(res.body)).not.toContain("hidden");
  });

  it("public BUSINESS endpoint returns only PUBLISHED Business FAQs; flipping status to DRAFT hides it", async () => {
    const app = buildApp();
    const superAdmin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(superAdmin._id, "SUPER_ADMIN");

    const biz = await createFaq(app, token, {
      question: "Business Q?",
      answer: "biz answer",
      audience: "BUSINESS",
    });

    let res = await request(app).get("/content/faqs?audience=BUSINESS");
    expect(res.body.data.faqs).toHaveLength(1);

    const patch = await request(app)
      .patch(`/super-admin/content/faqs/${biz.id}`)
      .set("Authorization", token)
      .send({ status: "DRAFT" });
    expect(patch.status).toBe(200);

    res = await request(app).get("/content/faqs?audience=BUSINESS");
    expect(res.body.data.faqs).toHaveLength(0);
  });

  it("a DRAFT FAQ is hidden publicly until it is flipped to PUBLISHED, then it appears", async () => {
    const app = buildApp();
    const superAdmin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(superAdmin._id, "SUPER_ADMIN");

    const faq = await createFaq(app, token, {
      question: "Draft-first customer Q?",
      answer: "answer text",
      audience: "CUSTOMER",
      status: "DRAFT",
    });

    let res = await request(app).get("/content/faqs?audience=CUSTOMER");
    expect(res.body.data.faqs).toHaveLength(0);

    const patch = await request(app)
      .patch(`/super-admin/content/faqs/${faq.id}`)
      .set("Authorization", token)
      .send({ status: "PUBLISHED" });
    expect(patch.status).toBe(200);

    res = await request(app).get("/content/faqs?audience=CUSTOMER");
    expect(res.body.data.faqs).toEqual([
      { id: faq.id, question: "Draft-first customer Q?", answer: "answer text" },
    ]);
  });

  it("public endpoint requires a valid audience (400 on missing/invalid) and needs no auth", async () => {
    const app = buildApp();
    expect((await request(app).get("/content/faqs")).status).toBe(400);
    expect((await request(app).get("/content/faqs?audience=EVERYONE")).status).toBe(400);
    expect((await request(app).get("/content/faqs?audience=CUSTOMER")).status).toBe(200);
  });

  // --- Validation -------------------------------------------------------------------------

  it("rejects invalid create payloads (unknown field, bad audience/status, empty question)", async () => {
    const app = buildApp();
    const superAdmin = await createUser("SUPER_ADMIN");
    const token = await bearerFor(superAdmin._id, "SUPER_ADMIN");

    const cases = [
      { question: "Q", answer: "A", audience: "CUSTOMER", surprise: true },
      { question: "Q", answer: "A", audience: "NOBODY" },
      { question: "Q", answer: "A", audience: "CUSTOMER", status: "ARCHIVED" },
      { question: "   ", answer: "A", audience: "CUSTOMER" },
      { answer: "A", audience: "CUSTOMER" },
    ];

    for (const body of cases) {
      const res = await request(app)
        .post("/super-admin/content/faqs")
        .set("Authorization", token)
        .send(body);
      expect(res.status).toBe(400);
    }
  });
});
