import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import mongoose, { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../../src/config/env.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import {
  BookingCreationClaimModel,
  commitPackageCheckoutClaimGrant,
} from "../../../src/modules/booking/booking-creation-claim.model.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import type { FinancialContract } from "../../../src/modules/booking/financial-contract.js";
import type {
  PackageCheckoutAffirmativeAction,
  PackageCheckoutPresentation,
} from "../../../src/modules/booking/package-checkout-acceptance.js";
import { PackageCheckoutAcceptanceService } from "../../../src/modules/booking/package-checkout-acceptance.service.js";
import {
  assertPackageCheckoutAcceptance,
  hashCanonicalPackageCheckoutContent,
} from "../../../src/modules/booking/package-checkout-binding.js";
import {
  type PackageCheckoutClaimGrant,
  PackageCheckoutCustomerAuthority,
} from "../../../src/modules/booking/package-checkout-customer-authority.js";
import { SessionModel } from "../../../src/modules/session/session.model.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { UserModel, UserProfileModel } from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
import { CHECK_TIME, checkoutFixture } from "../../helpers/package-checkout-fixture.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const actionFor = (p: PackageCheckoutPresentation): PackageCheckoutAffirmativeAction => ({
  version: 1,
  action: "ACCEPT_PACKAGE_CHECKOUT_TERMS",
  eventId: randomUUID(),
  presentationId: p.presentationId,
  challenge: p.challenge,
  templateVersion: 1,
  quoteHash: p.disclosure.content.quoteHash,
  disclosureHash: p.disclosure.contentHash,
});

/** Real JWT/user/session and Mongo CAS; quotes, names and affirmative UI actions are synthetic.
 * This is not a test of real disclosure delivery, checkbox interaction or production consent.
 */
const setup = async (mode: "FINITE" | "FOREVER" = "FOREVER", months: 6 | 12 = 6) => {
  const f = checkoutFixture(mode);
  if (mode === "FINITE") f.definition.set("contractTerms.validity.months", months);
  let now = CHECK_TIME;
  f.setTime(now);
  const claims = new BookingCreationClaimRepository();
  const retained = await claims.retainPackageCheckout({
    version: 1,
    state: "INTERNAL_RETAINED_NOT_ACCEPTED",
    seed: f.seed,
    intent: f.intent,
    quote: await f.prepare(),
  });
  await UserModel.create({
    _id: f.context.customerUserId,
    normalizedEmail: "customer@p3b1b.test",
    passwordHash: "synthetic-unused-password-hash",
    role: "CUSTOMER",
    status: "ACTIVE",
    security: { passwordUpdatedAt: new Date() },
  });
  const users = new UserRepository();
  const sessions = new SessionRepository();
  const tokens = new TokenService(sessions);
  const authority = new PackageCheckoutCustomerAuthority(tokens, users, () => now);
  const staff = { findManyByIdsForBusiness: vi.fn(async () => f.providers) };
  const profiles = {
    findProfilesByUserIds: vi.fn(async () =>
      f.providers.map(
        (p, i) =>
          new UserProfileModel({
            userId: p.userId,
            firstName: "Stylist",
            lastName: String(i + 1),
            gender: "other",
          }),
      ),
    ),
  };
  const service = new PackageCheckoutAcceptanceService(
    claims,
    authority,
    f.preparer,
    staff,
    profiles,
    () => now,
  );
  const token = await issueTestAccessToken(tokens, {
    userId: f.context.customerUserId,
    role: "CUSTOMER",
  });
  const authorization = `Bearer ${token}`;
  const present = () => service.present(authorization, f.context.businessId, f.seed.idempotencyKey);
  const accept = (event: unknown) =>
    service.accept(authorization, f.context.businessId, f.seed.idempotencyKey, event);
  return {
    f,
    claims,
    retained,
    users,
    sessions,
    tokens,
    authority,
    staff,
    profiles,
    service,
    authorization,
    present,
    accept,
    advance: (date: Date) => {
      now = date;
      f.setTime(date);
    },
  };
};

describe("inactive authenticated acceptance foundation with synthetic affirmative events", () => {
  beforeAll(async () => {
    const database = await connectIsolatedDatabase();
    expect(database).toMatch(/^bookly_auth_\d+_[a-f0-9]+$/);
    expect(mongoose.connection.host).toBe("127.0.0.1");
    const hello = await mongoose.connection.db?.admin().command({ hello: 1 });
    expect(hello?.["setName"]).toBeTruthy();
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await mongoose.connection.db
          ?.collection("p3b1b_preflight")
          .insertOne({ disposable: true }, { session });
      });
    } finally {
      await session.endSession();
    }
    process.stdout.write(
      `${JSON.stringify({ host: mongoose.connection.host, database, replicaSet: hello?.["setName"], transactionalPreflight: "PASS" })}\n`,
    );
  }, 60_000);
  beforeEach(clearIsolatedDatabase);
  afterAll(stopIsolatedReplicaSet);

  it("retains exact disclosure and immutable synthetic action under real server auth", async () => {
    const s = await setup();
    const p = await s.present();
    const event = actionFor(p);
    const accepted = await s.accept(event);
    expect(accepted.state).toBe("ACCEPTED_IMMUTABLE");
    expect(accepted.evidence.acceptedAt).toEqual(CHECK_TIME);
    expect(accepted.evidence.actorUserId).toEqual(s.f.context.customerUserId);
    expect(accepted.disclosureHash).toBe(p.disclosure.contentHash);
    expect(accepted.disclosurePayloadId).toEqual(p.disclosure.content.payloadId);
    expect(accepted.evidence.acceptedTermsPayloadId).toEqual(s.retained.seed.quoteId);
    expect(accepted.evidence.acceptedTermsHash).toBe(s.retained.quote.termsHash);
    const row = await BookingCreationClaimModel.findOne().orFail();
    expect(row.packageCheckoutRetention).toEqual(s.retained);
    expect(row.packageCheckoutPresentation?.disclosure).toEqual(p.disclosure);
    expect(row.packageCheckoutAcceptance?.evidence.acceptanceId).toEqual(
      accepted.evidence.acceptanceId,
    );
    expect(() =>
      assertPackageCheckoutAcceptance({
        retainedQuote: s.retained.quote,
        freshQuote: s.retained.quote,
        retainedEvidence: accepted.evidence,
        authenticatedActor: { userId: s.f.context.customerUserId, role: "CUSTOMER" },
        now: CHECK_TIME,
      }),
    ).not.toThrow();
  });
  it.each([6, 12] as const)(
    "retains FINITE%i accepted guarantee without inventing purchasedAt or a final expiry",
    async (months) => {
      const s = await setup("FINITE", months);
      const p = await s.present();
      const accepted = await s.accept(actionFor(p));
      expect(p.disclosure.content.renderedTermsSnapshot).toContain(`FINITE${months}`);
      expect(accepted.evidence).not.toHaveProperty("purchasedAt");
      const row = await BookingCreationClaimModel.findOne().orFail();
      expect(row.packageCheckoutRetention?.quote.payload.validity).toMatchObject({
        mode: "FINITE",
        months,
      });
      expect(row.packageCheckoutAcceptance).not.toHaveProperty("activationId");
    },
  );
  it("rejects a correctly signed legacy token without a bound session", async () => {
    const s = await setup();
    const token = await new SignJWT({ role: "CUSTOMER" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(s.f.context.customerUserId.toHexString())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(env.JWT_ACCESS_TOKEN_SECRET));
    await expect(
      s.service.present(`Bearer ${token}`, s.f.context.businessId, s.f.seed.idempotencyKey),
    ).rejects.toThrow("Session-bound Customer");
  });
  it("concurrent presentation converges before any acceptance", async () => {
    const s = await setup();
    const all = await Promise.all(Array.from({ length: 6 }, () => s.present()));
    expect(new Set(all.map((p) => p.presentationId.toHexString())).size).toBe(1);
    expect(new Set(all.map((p) => p.disclosure.contentHash)).size).toBe(1);
    expect(await BookingCreationClaimModel.countDocuments()).toBe(1);
  });
  it("duplicate and concurrent identical acceptance converges on one server ID/time", async () => {
    const s = await setup();
    const event = actionFor(await s.present());
    const all = await Promise.all(Array.from({ length: 6 }, () => s.accept(event)));
    expect(new Set(all.map((a) => a.evidence.acceptanceId.toHexString())).size).toBe(1);
    expect(await s.accept(event)).toEqual(all[0]);
  });
  it("concurrent conflicting event identities elect exactly one immutable acceptance", async () => {
    const s = await setup();
    const p = await s.present();
    const outcomes = await Promise.allSettled([s.accept(actionFor(p)), s.accept(actionFor(p))]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  it("committed exact replay precedes stale quote/policy reads and preserves ID/time", async () => {
    const s = await setup();
    const event = actionFor(await s.present());
    const first = await s.accept(event);
    s.advance(new Date(s.f.seed.expiresAt.getTime() + 1));
    s.f.definition.bundlePriceCents = 30000;
    vi.spyOn(s.f.preparer, "prepare").mockRejectedValue(
      new Error("must not revalidate a committed replay"),
    );
    expect(await s.accept(event)).toEqual(first);
    await expect(s.accept({ ...event, eventId: randomUUID() })).rejects.toThrow(
      "Conflicting acceptance",
    );
  });
  it("lost successful CAS response replays the stored exact acceptance", async () => {
    const s = await setup();
    const event = actionFor(await s.present());
    const original = s.claims.commitPackageCheckoutGrant.bind(s.claims);
    vi.spyOn(s.claims, "commitPackageCheckoutGrant").mockImplementationOnce(async (grant) => {
      await original(grant);
      throw new Error("lost commit response");
    });
    await expect(s.accept(event)).rejects.toThrow("lost commit response");
    const stored = (await BookingCreationClaimModel.findOne().orFail()).packageCheckoutAcceptance;
    expect(await s.accept(event)).toEqual(stored);
  });
  it("lost presentation response retrieves the original retained payload and challenge", async () => {
    const s = await setup();
    const original = s.claims.commitPackageCheckoutGrant.bind(s.claims);
    vi.spyOn(s.claims, "commitPackageCheckoutGrant").mockImplementationOnce(async (grant) => {
      await original(grant);
      throw new Error("lost presentation response");
    });
    await expect(s.present()).rejects.toThrow("lost presentation response");
    const row = await BookingCreationClaimModel.findOne().orFail();
    expect(await s.present()).toEqual(row.packageCheckoutPresentation);
  });
  it("a delayed authorized action cannot commit after quote expiry", async () => {
    const s = await setup();
    const event = actionFor(await s.present());
    const original = s.claims.commitPackageCheckoutGrant.bind(s.claims);
    vi.spyOn(s.claims, "commitPackageCheckoutGrant").mockImplementationOnce(async (grant) => {
      s.advance(s.f.seed.expiresAt);
      return original(grant);
    });
    await expect(s.accept(event)).rejects.toThrow("expired");
    expect(
      (await BookingCreationClaimModel.findOne().orFail()).packageCheckoutAcceptance,
    ).toBeUndefined();
  });
  it.each([undefined, "", "Basic fake", "Bearer forged", "Bearer seti_fake"])(
    "rejects unauthenticated credentials %s",
    async (credential) => {
      const s = await setup();
      await expect(
        s.service.present(credential, s.f.context.businessId, s.f.seed.idempotencyKey),
      ).rejects.toThrow();
      expect(
        (await BookingCreationClaimModel.findOne().orFail()).packageCheckoutPresentation,
      ).toBeUndefined();
    },
  );
  it.each(["SUSPENDED", "DELETED", "STAFF"])(
    "rejects current user state/role %s",
    async (state) => {
      const s = await setup();
      await UserModel.updateOne(
        { _id: s.f.context.customerUserId },
        { $set: state === "STAFF" ? { role: state } : { status: state } },
      );
      await expect(s.present()).rejects.toThrow("Active Customer session");
    },
  );
  it("rejects revoked sessions including accepted replay", async () => {
    const s = await setup();
    const event = actionFor(await s.present());
    await s.accept(event);
    await SessionModel.updateMany({}, { $set: { revokedAt: new Date() } });
    await expect(s.accept(event)).rejects.toThrow("Active Customer session");
  });
  it("fails closed during authentication storage outage", async () => {
    const s = await setup();
    vi.spyOn(s.tokens, "isAccessTokenSessionLive").mockRejectedValue(
      new Error("synthetic auth outage"),
    );
    await expect(s.present()).rejects.toThrow("synthetic auth outage");
  });
  it("foreign Customer, Business and ordinary operation cannot access acceptance", async () => {
    const s = await setup();
    const other = await UserModel.create({
      normalizedEmail: "other@p3b1b.test",
      passwordHash: "synthetic",
      role: "CUSTOMER",
      status: "ACTIVE",
      security: { passwordUpdatedAt: new Date() },
    });
    const otherToken = await issueTestAccessToken(s.tokens, {
      userId: other._id,
      role: "CUSTOMER",
    });
    await expect(
      s.service.present(`Bearer ${otherToken}`, s.f.context.businessId, s.f.seed.idempotencyKey),
    ).rejects.toThrow("Owned retained");
    await expect(
      s.service.present(s.authorization, new Types.ObjectId(), s.f.seed.idempotencyKey),
    ).rejects.toThrow("Owned retained");
    await s.claims.claim({
      idempotencyKey: "ordinary",
      businessId: s.f.context.businessId,
      actorUserId: s.f.context.customerUserId,
      bookingId: new Types.ObjectId(),
    });
    await expect(
      s.service.present(s.authorization, s.f.context.businessId, "ordinary"),
    ).rejects.toThrow("Owned retained");
  });
  it("a different live session cannot use the first session's presentation", async () => {
    const s = await setup();
    const p = await s.present();
    const token = await issueTestAccessToken(s.tokens, {
      userId: s.f.context.customerUserId,
      role: "CUSTOMER",
    });
    await expect(
      s.service.accept(
        `Bearer ${token}`,
        s.f.context.businessId,
        s.f.seed.idempotencyKey,
        actionFor(p),
      ),
    ).rejects.toThrow("session-bound");
  });
  it("a new live session of the same Customer can replay already committed exact evidence", async () => {
    const s = await setup();
    const event = actionFor(await s.present());
    const first = await s.accept(event);
    const token = await issueTestAccessToken(s.tokens, {
      userId: s.f.context.customerUserId,
      role: "CUSTOMER",
    });
    const replay = await s.service.accept(
      `Bearer ${token}`,
      s.f.context.businessId,
      s.f.seed.idempotencyKey,
      event,
    );
    expect(replay).toEqual(first);
  });
  it.each(["acceptedAt", "actorUserId", "renderedTerms", "accepted", "setupIntentId"])(
    "rejects client authority field %s",
    async (field) => {
      const s = await setup();
      const event = actionFor(await s.present());
      await expect(
        s.accept({ ...event, [field]: field === "accepted" ? true : "forged" }),
      ).rejects.toThrow();
    },
  );
  it.each([
    "action",
    "challenge",
    "quoteHash",
    "disclosureHash",
    "templateVersion",
    "presentationId",
  ])("rejects altered action %s", async (field) => {
    const s = await setup();
    const event = actionFor(await s.present());
    const bad =
      field === "templateVersion"
        ? 2
        : field === "presentationId"
          ? new Types.ObjectId()
          : field === "action"
            ? "SAVE_CARD"
            : "0".repeat(64);
    await expect(s.accept({ ...event, [field]: bad })).rejects.toThrow();
  });
  it("login alone or action without a delivered presentation cannot accept", async () => {
    const s = await setup();
    await expect(s.accept({ accepted: true })).rejects.toThrow();
    await expect(
      s.accept({
        version: 1,
        action: "ACCEPT_PACKAGE_CHECKOUT_TERMS",
        eventId: randomUUID(),
        presentationId: new Types.ObjectId(),
        challenge: "0".repeat(64),
        templateVersion: 1,
        quoteHash: s.retained.quote.termsHash,
        disclosureHash: "0".repeat(64),
      }),
    ).rejects.toThrow("presentation required");
  });
  it.each(["expiry", "policy", "price", "revision", "staff", "names", "service", "addons"])(
    "rejects changed %s before first acceptance",
    async (change) => {
      const s = await setup();
      const event = actionFor(await s.present());
      if (change === "expiry") s.advance(s.f.seed.expiresAt);
      if (change === "policy") s.f.configuredPolicy.noShowPercentage = 99;
      if (change === "price") s.f.definition.bundlePriceCents = 21000;
      if (change === "revision") s.f.definition.revision++;
      if (change === "staff") s.f.providers[0]?.set("employmentActive", false);
      if (change === "names") {
        const profiles = await s.profiles.findProfilesByUserIds();
        profiles[0]?.set("firstName", "Changed name");
        s.profiles.findProfilesByUserIds.mockResolvedValue(profiles);
      }
      if (change === "service") s.f.services[0]?.set("status", "INACTIVE");
      if (change === "addons")
        vi.mocked(s.f.dependencies.booking.resolveAddonSnapshots).mockResolvedValue([]);
      await expect(s.accept(event)).rejects.toThrow();
      expect(
        (await BookingCreationClaimModel.findOne().orFail()).packageCheckoutAcceptance,
      ).toBeUndefined();
    },
  );
  it("syntactically valid evidence cannot mint a runtime transition capability", async () => {
    await expect(commitPackageCheckoutClaimGrant({} as PackageCheckoutClaimGrant)).rejects.toThrow(
      "capability required",
    );
  });
  it("blocks generic saves, nested queries, replacements, pipelines, bulk and insertMany", async () => {
    const s = await setup();
    const event = actionFor(await s.present());
    await s.accept(event);
    const row = await BookingCreationClaimModel.findOne().orFail();
    row.set("packageCheckoutAcceptance.evidence.acceptedAt", new Date());
    row.markModified("packageCheckoutAcceptance");
    await expect(row.save()).rejects.toThrow();
    await expect(row.save({ validateBeforeSave: false })).rejects.toThrow("immutable");
    const filter = { idempotencyKey: s.f.seed.idempotencyKey };
    for (const update of [
      { $set: { "packageCheckoutAcceptance.state": "forged" } },
      { $unset: { packageCheckoutPresentation: 1 } },
      { $rename: { createdAt: "packageCheckoutAcceptance" } },
      { $set: { "packageCheckoutRetention.quote.payload.packageName": "forged" } },
    ])
      await expect(BookingCreationClaimModel.updateOne(filter, update)).rejects.toThrow(
        "immutable",
      );
    await expect(
      BookingCreationClaimModel.replaceOne(filter, { idempotencyKey: "forged" }),
    ).rejects.toThrow();
    await expect(
      BookingCreationClaimModel.updateOne(filter, [{ $unset: "packageCheckoutAcceptance" }], {
        updatePipeline: true,
      }),
    ).rejects.toThrow();
    await expect(
      BookingCreationClaimModel.bulkWrite([
        { updateOne: { filter, update: { $unset: { packageCheckoutAcceptance: 1 } } } },
      ]),
    ).rejects.toThrow("canonical single-claim");
    await expect(BookingCreationClaimModel.insertMany([row.toObject()])).rejects.toThrow(
      "canonical claim creation",
    );
    expect((await BookingCreationClaimModel.deleteMany(filter)).deletedCount).toBe(0);
    const clone = new BookingCreationClaimModel({ ...row.toObject(), _id: new Types.ObjectId() });
    await expect(clone.save({ validateBeforeSave: false })).rejects.toThrow("verified canonical");
    await expect(
      BookingCreationClaimModel.findOneAndUpdate(filter, {
        $unset: { packageCheckoutAcceptance: 1 },
      }),
    ).rejects.toThrow("immutable");
    await expect(
      BookingCreationClaimModel.updateMany(filter, { $unset: { packageCheckoutAcceptance: 1 } }),
    ).rejects.toThrow("immutable");
  });
  it("even a document loaded before acceptance cannot delete retained evidence", async () => {
    const s = await setup();
    const old = await BookingCreationClaimModel.findOne().orFail();
    await s.accept(actionFor(await s.present()));
    await old.deleteOne();
    expect(await BookingCreationClaimModel.countDocuments()).toBe(1);
  });
  it("retained evidence cannot be changed by mutating a returned presentation", async () => {
    const s = await setup();
    const p = await s.present();
    const event = actionFor(p);
    p.disclosure.content.renderedTermsSnapshot = "forged terms";
    p.disclosure.contentHash = hashCanonicalPackageCheckoutContent(p.disclosure.content);
    const accepted = await s.accept(event);
    expect(accepted.disclosureHash).toBe(event.disclosureHash);
  });
  it("accepted claims stay isolated from financial preparation/release and create no purchase/payment side effects", async () => {
    const s = await setup();
    const accepted = await s.accept(actionFor(await s.present()));
    const q = s.retained.quote.payload;
    const contract: FinancialContract = {
      version: 2,
      productKind: "PACKAGE_PURCHASE",
      classification: "FIRST",
      idempotencyKey: s.f.seed.idempotencyKey,
      bookingId: q.originBookingId,
      customerUserId: q.customerUserId,
      businessId: q.businessId,
      businessClientId: s.f.client._id,
      currency: "EUR",
      eligibleBasisCents: 20000,
      requiredUpfrontCents: 3500,
      onlineChargeCents: 3500,
      promoDiscountCents: 0,
      travelFeeCents: 0,
      packageBundlePriceCents: 20000,
      bookingTotalCents: 20500,
      upfrontLedgerType: "PLATFORM_FEE",
    };
    await expect(
      s.claims.recordFinancialContract(s.f.seed.idempotencyKey, contract),
    ).rejects.toMatchObject({ details: [{ code: "BOOKING_FINANCIAL_CONTRACT_CONFLICT" }] });
    await s.claims.release(s.f.seed.idempotencyKey);
    expect(await s.claims.findByIdempotencyKey(s.f.seed.idempotencyKey)).toBeNull();
    expect(
      (await BookingCreationClaimModel.findOne().orFail()).packageCheckoutAcceptance?.evidence
        .acceptanceId,
    ).toEqual(accepted.evidence.acceptanceId);
    for (const collection of [
      "bookings",
      "packageprogresses",
      "paymentattempts",
      "refundoperations",
      "bookingslotreservations",
      "bookingfinancialtransactions",
    ])
      expect(await mongoose.connection.db?.collection(collection).countDocuments()).toBe(0);
    expect(s.f.client.financialRelationship?.state).not.toBe("FIRST_PENDING");
  });
});
