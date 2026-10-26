import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import mongoose, { type ClientSession, Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import "../../../src/modules/booking/booking-creation-claim.model.js";
import { BusinessClientModel } from "../../../src/modules/client/client.model.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { SessionModel } from "../../../src/modules/session/session.model.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { UserModel } from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "../../helpers/consent-isolated-database.js";

// P3-B1c-CONTRACT-GATE characterization only. Real local MongoDB and the actual source
// writers; the "consent" row is a probe collection, never a canonical claim or authority.
// The fence shape is a candidate under evaluation, not an approved production design.
beforeAll(async () => {
  await connectIsolatedDatabase();
  const name = mongoose.connection.name;
  if (
    !/^bookly_consent_v1_\d+_[a-f0-9]{32}$/.test(name) ||
    mongoose.connection.host !== "127.0.0.1"
  )
    throw Error("Owned disposable database required");
  await BusinessClientModel.createCollection();
  await BusinessClientModel.createIndexes();
}, 60000);
beforeEach(clearIsolatedDatabase);
afterAll(stopIsolatedReplicaSet);

const db = () => {
  const value = mongoose.connection.db;
  if (!value) throw Error("Owned database required");
  return value;
};
const probe = () => db().collection<{ _id: string; family: string }>("contract_gate_consent_probe");
const record = async (value: object) => {
  const path = process.env["BOOKLY_GATE_EVIDENCE_PATH"];
  if (path) await appendFile(path, `${JSON.stringify(value)}\n`);
};
const future = () => new Date(Date.now() + 86_400_000);

const seed = async () => {
  const userId = new Types.ObjectId(),
    businessId = new Types.ObjectId(),
    clientId = new Types.ObjectId(),
    consentRowId = new Types.ObjectId(),
    otherRowId = new Types.ObjectId();
  const tag = userId.toHexString();
  const family = `gate-family-${tag}`;
  await UserModel.collection.insertOne({
    _id: userId,
    normalizedEmail: `${tag}@probe.invalid`,
    authProviders: ["PASSWORD"],
    role: "CUSTOMER",
    status: "ACTIVE",
    security: { passwordUpdatedAt: new Date() },
    __v: 0,
  });
  await SessionModel.collection.insertMany([
    {
      _id: consentRowId,
      userId,
      refreshTokenHash: `h1-${tag}`,
      tokenFamilyId: family,
      expiresAt: future(),
      revocationVersion: 0,
      createdAt: new Date(),
    },
    {
      _id: otherRowId,
      userId,
      refreshTokenHash: `h2-${tag}`,
      tokenFamilyId: `gate-other-${tag}`,
      expiresAt: future(),
      revocationVersion: 0,
      createdAt: new Date(),
    },
  ]);
  await BusinessClientModel.collection.insertOne({
    _id: clientId,
    businessId,
    createdByUserId: userId,
    firstName: "Probe",
    normalizedEmail: `client-${tag}@probe.invalid`,
    phone: { countryCode: "357", nationalNumber: tag.slice(-8), e164: `+357${tag.slice(-8)}` },
    linkState: "LINKED",
    linkedUserId: userId,
    __v: 0,
  });
  return {
    userId,
    businessId,
    clientId,
    consentRowId,
    otherRowId,
    family,
    claimId: `claim-${tag}`,
  };
};
type Fx = Awaited<ReturnType<typeof seed>>;

/** Candidate shared-write fence: the exact live session row, the User row and the exact
 * pinned BusinessClient row, then the probe consent row, all in one transaction. */
const fence = async (f: Fx, session: ClientSession, row = f.consentRowId) => {
  const s = await SessionModel.updateOne(
    { _id: row, userId: f.userId, tokenFamilyId: f.family, revokedAt: { $exists: false } },
    { $set: { lastUsedAt: new Date() } },
    { session },
  );
  const u = await UserModel.updateOne(
    { _id: f.userId, role: "CUSTOMER", status: "ACTIVE" },
    { $inc: { __v: 1 } },
    { session, timestamps: false },
  );
  const c = await BusinessClientModel.updateOne(
    { _id: f.clientId, businessId: f.businessId, linkedUserId: f.userId },
    { $inc: { __v: 1 } },
    { session, timestamps: false },
  );
  if (s.modifiedCount !== 1 || u.modifiedCount !== 1 || c.modifiedCount !== 1) return false;
  await probe().insertOne({ _id: f.claimId, family: f.family }, { session });
  return true;
};
const txn = async () => {
  const session = await mongoose.startSession({ causalConsistency: true });
  session.startTransaction({
    readConcern: { level: "snapshot" },
    writeConcern: { w: "majority", j: true },
  });
  return session;
};
const code = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;

const sessions = new SessionRepository(),
  users = new UserRepository(),
  clients = new ClientRepository();
type Writer = {
  name: string;
  sourcePath: string;
  invalidatesConsentAuthority: boolean;
  run: (f: Fx) => Promise<unknown>;
};
const writers: Writer[] = [
  {
    name: "SessionRepository.revokeFamily (logout / intended logout / refresh reuse)",
    sourcePath: "src/modules/session/session.repository.ts revokeFamily",
    invalidatesConsentAuthority: true,
    run: (f) => sessions.revokeFamily(f.family),
  },
  {
    name: "SessionRepository.revokeAllForUser (email change / account closure / password fallback)",
    sourcePath: "src/modules/session/session.repository.ts revokeAllForUser",
    invalidatesConsentAuthority: true,
    run: (f) => sessions.revokeAllForUser(f.userId),
  },
  {
    name: "SessionRepository.revokeAllForUserExcept (password change from ANOTHER device)",
    sourcePath: "src/modules/session/session.repository.ts revokeAllForUserExcept",
    invalidatesConsentAuthority: true,
    run: (f) => sessions.revokeAllForUserExcept(f.userId, f.otherRowId),
  },
  {
    name: "SessionRepository.revokeAllForUserExcept (password change from the SAME device)",
    sourcePath: "src/modules/session/session.repository.ts revokeAllForUserExcept",
    invalidatesConsentAuthority: false,
    run: (f) => sessions.revokeAllForUserExcept(f.userId, f.consentRowId),
  },
  {
    name: "UserRepository.softDeleteCustomer (account closure core transaction)",
    sourcePath: "src/modules/user/user.repository.ts softDeleteCustomer",
    invalidatesConsentAuthority: true,
    run: (f) =>
      users.softDeleteCustomer(f.userId, {
        tombstoneEmail: `deleted-${f.userId.toHexString()}@probe.invalid`,
        unusablePasswordHash: "!",
        deletedAt: new Date(),
        deletedBy: { actorUserId: f.userId, actorRole: "CUSTOMER" },
      }),
  },
  {
    name: "UserRepository.updateRole (staff invitation role change)",
    sourcePath: "src/modules/user/user.repository.ts updateRole",
    invalidatesConsentAuthority: true,
    run: (f) => users.updateRole(f.userId, "STAFF"),
  },
  {
    name: "UserRepository.updatePasswordHash (password change; sessions handled separately)",
    sourcePath: "src/modules/user/user.repository.ts updatePasswordHash",
    invalidatesConsentAuthority: false,
    run: (f) => users.updatePasswordHash(f.userId, "probe-new-hash"),
  },
  {
    name: "OUT-OF-BAND status SUSPENDED (no in-repo writer exists; simulated manual write)",
    sourcePath: "none in repository; UserModel status enum only",
    invalidatesConsentAuthority: true,
    run: (f) =>
      UserModel.collection.updateOne({ _id: f.userId }, { $set: { status: "SUSPENDED" } }),
  },
  {
    name: "ClientRepository.setLinkState IDENTITY_CONFLICT (Business contact edit / identity resolution)",
    sourcePath: "src/modules/client/client.repository.ts setLinkState",
    invalidatesConsentAuthority: true,
    run: (f) => clients.setLinkState(f.clientId, { linkState: "IDENTITY_CONFLICT" }),
  },
  {
    name: "ClientRepository.unlinkAndAnonymizeForUserDeletion (account closure cleanup)",
    sourcePath: "src/modules/client/client.repository.ts unlinkAndAnonymizeForUserDeletion",
    invalidatesConsentAuthority: true,
    run: (f) =>
      clients.unlinkAndAnonymizeForUserDeletion(f.userId, {
        normalizedEmail: `t-${f.userId.toHexString()}@probe.invalid`,
        phoneE164: `+0${f.userId.toHexString().slice(-8)}`,
      }),
  },
  {
    name: "ClientRepository.archiveById (Business archives the Client; policy effect undecided)",
    sourcePath: "src/modules/client/client.repository.ts archiveById",
    invalidatesConsentAuthority: false,
    run: (f) => clients.archiveById(f.businessId, f.clientId),
  },
];

it.each(writers)("GATE-E1 native writer BEFORE fence (in snapshot): $name", async (writer) => {
  const f = await seed();
  const session = await txn();
  let outcome: string;
  try {
    // Pre-write authority reads inside the snapshot, as the current source does before CAS.
    await SessionModel.findById(f.consentRowId).session(session).orFail();
    await UserModel.findById(f.userId).session(session).orFail();
    await BusinessClientModel.findById(f.clientId).session(session).orFail();
    await writer.run(f);
    try {
      if (await fence(f, session)) {
        await session.commitTransaction();
        outcome = "FENCE_WROTE_AND_COMMITTED";
      } else {
        await session.abortTransaction();
        outcome = "FENCE_REFUSED_STATE";
      }
    } catch (error) {
      if (code(error) !== 112) throw error;
      outcome = "WRITE_CONFLICT_112_ABORT";
    }
  } finally {
    if (session.inTransaction()) await session.abortTransaction();
    await session.endSession();
  }
  const committed = (await probe().findOne({ _id: f.claimId })) !== null;
  // Safety: an invalidating writer that wins first must never leave a committed consent probe.
  if (writer.invalidatesConsentAuthority) expect(committed).toBe(false);
  // Liveness control: the same-device password change does not touch the fenced rows.
  if (writer.name.includes("SAME device")) expect(committed).toBe(true);
  await record({
    experiment: "GATE_E1_NATIVE_WRITER_BEFORE_FENCE",
    writer: writer.name,
    sourcePath: writer.sourcePath,
    invalidates: writer.invalidatesConsentAuthority,
    outcome,
    consentProbeCommitted: committed,
    evidenceClass: "REAL_MONGODB_TRANSACTION_REAL_SOURCE_WRITER",
  });
});

it.each(writers)("GATE-E2 fence BEFORE native writer: $name", async (writer) => {
  const f = await seed();
  const session = await txn();
  let pendingAtCommit = false;
  try {
    expect(await fence(f, session)).toBe(true);
    let done = false;
    const native = writer.run(f).then(() => {
      done = true;
    });
    await delay(400);
    pendingAtCommit = !done;
    await session.commitTransaction();
    await native;
  } finally {
    if (session.inTransaction()) await session.abortTransaction();
    await session.endSession();
  }
  const committed = (await probe().findOne({ _id: f.claimId })) !== null;
  const row = await SessionModel.findById(f.consentRowId).orFail();
  const user = await UserModel.findById(f.userId).orFail();
  const client = await BusinessClientModel.findById(f.clientId).orFail();
  expect(committed).toBe(true);
  await record({
    experiment: "GATE_E2_FENCE_BEFORE_NATIVE_WRITER",
    writer: writer.name,
    invalidates: writer.invalidatesConsentAuthority,
    consentProbeCommitted: committed,
    nativeWriterPendingAtConsentCommit: pendingAtCommit,
    after: {
      sessionRevoked: row.revokedAt instanceof Date,
      userStatus: user.status,
      userRole: user.role,
      clientLinked: client.linkedUserId?.equals(f.userId) ?? false,
      clientArchived: client.archivedAt instanceof Date,
    },
    interpretation: "consent ordered before the invalidation; the writer applied afterwards",
    evidenceClass: "REAL_MONGODB_TRANSACTION_REAL_SOURCE_WRITER",
  });
});

it("GATE-E3 refresh rotation conflicts with the fence, then a retry fences the live successor", async () => {
  const f = await seed();
  const old = await SessionModel.findById(f.consentRowId).orFail();
  const session = await txn();
  let first: string;
  try {
    await SessionModel.findById(f.consentRowId).session(session).orFail();
    await sessions.rotate(old, `rotated-${f.claimId}`, future());
    try {
      await fence(f, session);
      first = "UNEXPECTED_SUCCESS";
    } catch (error) {
      if (code(error) !== 112) throw error;
      first = "WRITE_CONFLICT_112_ABORT";
    }
  } finally {
    if (session.inTransaction()) await session.abortTransaction();
    await session.endSession();
  }
  const successor = await SessionModel.findOne({
    tokenFamilyId: f.family,
    revokedAt: { $exists: false },
  }).orFail();
  const retry = await txn();
  let retried = false;
  try {
    retried = await fence(f, retry, successor._id);
    if (retried) await retry.commitTransaction();
  } finally {
    if (retry.inTransaction()) await retry.abortTransaction();
    await retry.endSession();
  }
  expect(first).toBe("WRITE_CONFLICT_112_ABORT");
  expect(retried).toBe(true);
  await record({
    experiment: "GATE_E3_ROTATION_CONFLICT_THEN_SUCCESSOR",
    firstAttempt: first,
    retryOnLiveSuccessorCommitted: retried,
    interpretation: "rotation is not revocation; the fence costs a whole-transaction retry",
    evidenceClass: "REAL_MONGODB_TRANSACTION_REAL_SOURCE_WRITER",
  });
});

it("GATE-E4 time-based session expiry is NOT ordered by any write fence", async () => {
  const f = await seed();
  const expiresAt = new Date(Date.now() + 400);
  await SessionModel.collection.updateOne({ _id: f.consentRowId }, { $set: { expiresAt } });
  const live = await sessions.hasLiveFamily(f.family, f.userId);
  const session = await txn();
  let committed = false;
  try {
    await SessionModel.findById(f.consentRowId).session(session).orFail();
    await delay(800); // the session expires by elapsed time while the attempt waits
    committed = await fence(f, session);
    if (committed) await session.commitTransaction();
  } finally {
    if (session.inTransaction()) await session.abortTransaction();
    await session.endSession();
  }
  const liveAfter = await sessions.hasLiveFamily(f.family, f.userId);
  expect(live).toBe(true);
  expect(liveAfter).toBe(false);
  expect(committed).toBe(true);
  await record({
    experiment: "GATE_E4_EXPIRY_NOT_WRITE_FENCED",
    liveAtValidation: live,
    liveAfterCommit: liveAfter,
    consentProbeCommittedAfterExpiry: committed,
    interpretation:
      "a write fence orders writers, not elapsed time; live-at-C would also need a trusted-time expiry bound",
    evidenceClass: "REAL_MONGODB_TRANSACTION_APP_CLOCK_EXPIRY",
  });
});

it("GATE-F1 historical unlink/relink of the SAME row passes an exact fence; __v is not a link epoch", async () => {
  const f = await seed();
  const atQuote = await BusinessClientModel.findById(f.clientId).orFail();
  await clients.setLinkState(f.clientId, { linkState: "IDENTITY_CONFLICT" });
  await clients.setLinkState(f.clientId, { linkState: "LINKED", linkedUserId: f.userId });
  const atConsent = await BusinessClientModel.findById(f.clientId).orFail();
  const session = await txn();
  let fenced = false;
  try {
    fenced = await fence(f, session);
    if (fenced) await session.commitTransaction();
  } finally {
    if (session.inTransaction()) await session.abortTransaction();
    await session.endSession();
  }
  expect(fenced).toBe(true);
  expect(atConsent.__v).toBe(atQuote.__v);
  await record({
    experiment: "GATE_F1_SAME_ROW_ABA_NOT_DETECTED_BY_FENCE",
    versionAtQuote: atQuote.__v,
    versionAtConsentAfterUnlinkRelink: atConsent.__v,
    exactFenceAccepted: fenced,
    interpretation:
      "concurrent writers are ordered, but an intervening historical unlink/relink is invisible without a prospective link generation",
    evidenceClass: "REAL_MONGODB_REAL_SOURCE_WRITER",
  });
});

it("GATE-F2 replacement Client B under the real unique pair index is not adopted by an exact fence on A", async () => {
  const f = await seed();
  await clients.setLinkState(f.clientId, { linkState: "IDENTITY_CONFLICT" });
  const replacement = new Types.ObjectId();
  await BusinessClientModel.collection.insertOne({
    _id: replacement,
    businessId: f.businessId,
    createdByUserId: f.userId,
    firstName: "Replacement",
    normalizedEmail: `b-${f.claimId}@probe.invalid`,
    phone: { countryCode: "357", nationalNumber: "99000000", e164: `+35799${f.claimId.slice(-6)}` },
    linkState: "LINKED",
    linkedUserId: f.userId,
    __v: 0,
  });
  const current = await clients.findByBusinessIdAndLinkedUserId(f.businessId, f.userId);
  const session = await txn();
  let fenced = true;
  try {
    fenced = await fence(f, session);
    await session.abortTransaction();
  } finally {
    if (session.inTransaction()) await session.abortTransaction();
    await session.endSession();
  }
  expect(current?._id.equals(replacement)).toBe(true);
  expect(fenced).toBe(false);
  await record({
    experiment: "GATE_F2_REPLACEMENT_CLIENT_NOT_ADOPTED",
    currentPairLookupReturnsReplacement: current?._id.equals(replacement) ?? false,
    exactPinnedFenceRefused: !fenced,
    evidenceClass: "REAL_MONGODB_REAL_UNIQUE_INDEX_REAL_SOURCE_WRITER",
  });
});
