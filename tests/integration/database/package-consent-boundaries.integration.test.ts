import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mongo } from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingCreationClaimModel } from "../../../src/modules/booking/booking-creation-claim.model.js";
import { PackageCheckoutConflictError } from "../../../src/modules/booking/package-checkout.errors.js";
import { SessionModel } from "../../../src/modules/session/session.model.js";
import { UserModel } from "../../../src/modules/user/user.model.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
import { setupConsentHttp } from "../../helpers/consent-http-fixture.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "../../helpers/consent-isolated-database.js";

const row = () => BookingCreationClaimModel.findOne().orFail();
const prepared = async () => {
  const s = await setupConsentHttp();
  expect((await s.quote()).status).toBe(200);
  const p = (await s.present()).body.data;
  const retained = (await row()).packageCheckoutRetention;
  if (!retained) throw new Error("Missing quote");
  expect(retained.seed.expiresAt.getTime() - retained.seed.issuedAt.getTime()).toBe(1800000);
  return { ...s, retained, p, event: s.actionFor(p) };
};

describe("30-minute consent cutoff, real persisted CAS, controlled server quote clock", () => {
  beforeAll(connectIsolatedDatabase, 60000);
  beforeEach(clearIsolatedDatabase);
  afterEach(() => vi.restoreAllMocks());
  afterAll(stopIsolatedReplicaSet);

  it.each([-1, 0, 1])("new acceptance at expiry %+i milliseconds", async (offset) => {
    const s = await prepared();
    s.advance(new Date(s.retained.seed.expiresAt.getTime() + offset));
    expect((await s.accept(s.event)).status).toBe(offset < 0 ? 200 : 409);
    expect(Boolean((await row()).packageCheckoutAcceptance)).toBe(offset < 0);
  });

  it("retry, repeated presentation and FOREVER do not slide original timestamps", async () => {
    const s = await prepared();
    expect(s.retained.quote.payload.validity.mode).toBe("FOREVER");
    s.advance(new Date(s.retained.seed.expiresAt.getTime() - 1));
    expect((await s.quote()).status).toBe(200);
    expect((await s.present()).body.data).toEqual(s.p);
    const stored = (await row()).packageCheckoutRetention;
    expect(stored?.seed.issuedAt).toEqual(s.retained.seed.issuedAt);
    expect(stored?.seed.expiresAt).toEqual(s.retained.seed.expiresAt);
  });

  it("preparation crossing expiry cannot return a newly acceptable quote", async () => {
    const s = await setupConsentHttp();
    const prepare = s.f.preparer.prepare.bind(s.f.preparer);
    vi.spyOn(s.f.preparer, "prepare").mockImplementation(async (...args) => {
      const q = await prepare(...args);
      s.advance(q.payload.expiresAt);
      return q;
    });
    expect((await s.quote()).status).toBe(409);
    expect((await row()).packageCheckoutAcceptance).toBeUndefined();
  });

  it("expired operation stays historical; fresh operation requires fresh presentation and event", async () => {
    const s = await prepared();
    s.advance(s.retained.seed.expiresAt);
    expect((await s.accept(s.event)).status).toBe(409);
    const id = randomUUID();
    expect(
      (
        await request(s.app)
          .post(`${s.base}/quotes`)
          .set("Authorization", s.auth)
          .send({ operationId: id, intent: s.f.intent })
      ).status,
    ).toBe(200);
    const path = `${s.base}/operations/${id}`;
    expect(
      (await request(s.app).post(`${path}/acceptance`).set("Authorization", s.auth).send(s.event))
        .status,
    ).toBe(409);
    const p = (
      await request(s.app).post(`${path}/presentation`).set("Authorization", s.auth).send({})
    ).body.data;
    expect(p.quoteHash).not.toBe(s.p.quoteHash);
    expect(
      (
        await request(s.app)
          .post(`${path}/acceptance`)
          .set("Authorization", s.auth)
          .send(s.actionFor(p))
      ).status,
    ).toBe(200);
    expect(await BookingCreationClaimModel.countDocuments()).toBe(2);
  });

  it("committed evidence replays unchanged after expiry and policy changes", async () => {
    const s = await prepared();
    const first = await s.accept(s.event);
    s.advance(new Date(s.retained.seed.expiresAt.getTime() + 1));
    s.f.configuredPolicy.noShowPercentage = 99;
    expect((await s.accept(s.event)).body.data).toEqual(first.body.data);
    expect((await s.present()).body.data.accepted).toEqual(first.body.data);
  });

  it.each(["price", "policy", "availability"])(
    "changed %s rejects before the TTL",
    async (fact) => {
      const s = await prepared();
      if (fact === "price") s.f.definition.bundlePriceCents = 9999;
      if (fact === "policy") s.f.configuredPolicy.noShowPercentage = 99;
      if (fact === "availability")
        vi.spyOn(s.f.dependencies.availability, "getAvailability").mockRejectedValue(
          new PackageCheckoutConflictError("No slot"),
        );
      expect((await s.accept(s.event)).status).toBe(409);
      expect((await row()).packageCheckoutAcceptance).toBeUndefined();
    },
  );

  it("same-family refreshed access token accepts, a new family cannot newly accept", async () => {
    const s = await prepared();
    const claims = await s.services.tokens.verifyAccessToken(s.auth.slice(7));
    const renewed = await s.services.tokens.createAccessToken({
      userId: s.f.context.customerUserId,
      role: "CUSTOMER",
      sessionFamilyId: claims.sid ?? "",
    });
    const other = await issueTestAccessToken(s.services.tokens, {
      userId: s.f.context.customerUserId,
      role: "CUSTOMER",
    });
    expect(
      (
        await request(s.app)
          .post(`${s.path}/acceptance`)
          .set("Authorization", `Bearer ${other}`)
          .send(s.event)
      ).status,
    ).toBe(409);
    const first = await request(s.app)
      .post(`${s.path}/acceptance`)
      .set("Authorization", `Bearer ${renewed}`)
      .send(s.event);
    expect(first.status).toBe(200);
    expect(
      (
        await request(s.app)
          .post(`${s.path}/acceptance`)
          .set("Authorization", `Bearer ${other}`)
          .send(s.event)
      ).body.data,
    ).toEqual(first.body.data);
    expect((await row()).packageCheckoutRetention?.seed.expiresAt).toEqual(
      s.retained.seed.expiresAt,
    );
  });

  it.each(["revoked", "expired", "suspended"])(
    "%s authority cannot newly accept",
    async (state) => {
      const s = await prepared();
      if (state === "suspended")
        await UserModel.updateOne(
          { _id: s.f.context.customerUserId },
          { $set: { status: "SUSPENDED" } },
        );
      else
        await SessionModel.updateMany(
          {},
          { $set: state === "expired" ? { expiresAt: new Date(0) } : { revokedAt: new Date() } },
        );
      expect([401, 403]).toContain((await s.accept(s.event)).status);
      expect((await row()).packageCheckoutAcceptance).toBeUndefined();
    },
  );

  it("eight identical concurrent actions converge; conflicting action cannot replace the winner", async () => {
    const s = await prepared();
    s.advance(new Date(s.retained.seed.expiresAt.getTime() - 1));
    const results = await Promise.all(Array.from({ length: 8 }, () => s.accept(s.event)));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(new Set(results.map((r) => r.body.data.acceptanceId)).size).toBe(1);
    expect((await s.accept({ ...s.event, eventId: randomUUID() })).status).toBe(409);
  });

  it("a lost HTTP response after persistence is recovered by the exact original action", async () => {
    const s = await prepared();
    let drop = true;
    const server = createServer((req, res) => {
      if (drop && req.method === "POST" && req.url?.endsWith("/acceptance")) {
        drop = false;
        res.end = () => {
          res.destroy();
          return res;
        };
      }
      s.app(req, res);
    });
    try {
      await expect(
        request(server).post(`${s.path}/acceptance`).set("Authorization", s.auth).send(s.event),
      ).rejects.toThrow();
      const accepted = (await row()).packageCheckoutAcceptance;
      expect(accepted).toBeTruthy();
      expect((await s.accept(s.event)).body.data.acceptanceId).toBe(
        String(accepted?.evidence.acceptanceId),
      );
    } finally {
      if (server.listening) await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it("a posted client timestamp cannot extend expired quote authority", async () => {
    const s = await prepared();
    s.advance(s.retained.seed.expiresAt);
    expect(
      (await s.accept({ ...s.event, acceptedAt: s.retained.seed.issuedAt.toISOString() })).status,
    ).toBe(400);
    expect((await s.accept(s.event)).status).toBe(409);
    expect((await row()).packageCheckoutAcceptance).toBeUndefined();
  });

  it("lost server result is recovered by exact retry without regenerating evidence", async () => {
    const s = await prepared();
    const commit = s.services.claims.commitPackageCheckoutGrant.bind(s.services.claims);
    vi.spyOn(s.services.claims, "commitPackageCheckoutGrant").mockImplementationOnce(
      async (grant) => {
        await commit(grant);
        throw new mongo.MongoNetworkError("Injected lost acknowledgement");
      },
    );
    expect((await s.accept(s.event)).status).toBe(503);
    const original = (await row()).packageCheckoutAcceptance;
    expect(original).toBeTruthy();
    expect((await s.accept(s.event)).body.data.acceptanceId).toBe(
      String(original?.evidence.acceptanceId),
    );
  });

  it("grant delayed before final consumption is rejected at expiry", async () => {
    const s = await prepared();
    const commit = s.services.claims.commitPackageCheckoutGrant.bind(s.services.claims);
    vi.spyOn(s.services.claims, "commitPackageCheckoutGrant").mockImplementationOnce(
      async (grant) => {
        s.advance(s.retained.seed.expiresAt);
        return commit(grant);
      },
    );
    expect((await s.accept(s.event)).status).toBe(409);
    expect((await row()).packageCheckoutAcceptance).toBeUndefined();
  });

  it("characterizes a pre-expiry grant whose actual Mongo dispatch is held until after expiry", async () => {
    const s = await prepared();
    const lastInstant = new Date(s.retained.seed.expiresAt.getTime() - 1);
    s.advance(lastInstant);
    const update = BookingCreationClaimModel.collection.updateOne.bind(
      BookingCreationClaimModel.collection,
    );
    const trace: Record<string, unknown> = {
      eventAndGrantAt: lastInstant.toISOString(),
      expiresAt: s.retained.seed.expiresAt.toISOString(),
    };
    vi.spyOn(BookingCreationClaimModel.collection, "updateOne").mockImplementationOnce(
      async (...args) => {
        expect((await row()).packageCheckoutAcceptance).toBeUndefined();
        const dispatchAt = new Date(s.retained.seed.expiresAt.getTime() + 1);
        s.advance(dispatchAt);
        trace["actualDispatchAt"] = dispatchAt.toISOString();
        trace["filter"] = args[0];
        const result = await update(...args);
        trace["mutationAcknowledgedAfterDeadline"] = true;
        return result;
      },
    );
    const response = await s.accept(s.event);
    // Characterization, not endorsement: existing CAS has no atomic deadline predicate.
    expect(response.status).toBe(200);
    expect((await row()).packageCheckoutAcceptance?.evidence.acceptedAt).toEqual(lastInstant);
    process.stdout.write(
      `${JSON.stringify({ delayedMongoDispatch: trace, observed: "PERMITTED" })}\n`,
    );
  });

  it("acknowledgement delayed past expiry differs from mutation delayed past expiry", async () => {
    const s = await prepared();
    const lastInstant = new Date(s.retained.seed.expiresAt.getTime() - 1);
    s.advance(lastInstant);
    const update = BookingCreationClaimModel.collection.updateOne.bind(
      BookingCreationClaimModel.collection,
    );
    vi.spyOn(BookingCreationClaimModel.collection, "updateOne").mockImplementationOnce(
      async (...args) => {
        const result = await update(...args);
        expect((await row()).packageCheckoutAcceptance?.evidence.acceptedAt).toEqual(lastInstant);
        s.advance(new Date(s.retained.seed.expiresAt.getTime() + 1));
        return result;
      },
    );
    expect((await s.accept(s.event)).status).toBe(200);
  });
});
