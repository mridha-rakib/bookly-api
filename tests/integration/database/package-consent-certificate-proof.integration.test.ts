import { appendFile } from "node:fs/promises";
import mongoose, { type ClientSession, Types } from "mongoose";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import "../../../src/modules/booking/booking-creation-claim.model.js";
import { SessionModel } from "../../../src/modules/session/session.model.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import {
  conditionalProbeCheck,
  NS_PER_MS,
  type ProbeConsent,
  type ProbeQuote,
  type ProbeToken,
  type ProbeWitness,
  probeDigest,
  probeQuote,
  probeWitness,
  syntheticIntervalSigner,
} from "../../helpers/consent-certificate-proof-probe.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "../../helpers/consent-isolated-database.js";

// Real local MongoDB, synthetic interval bounds only. No production certificate/authority.
beforeAll(connectIsolatedDatabase, 60000);
beforeEach(clearIsolatedDatabase);
afterEach(() => vi.restoreAllMocks());
afterAll(stopIsolatedReplicaSet);
type Row = {
  _id: string;
  quote: ProbeQuote;
  consent?: ProbeConsent;
  witness?: ProbeWitness;
  certificate?: ProbeToken;
  consumedBy?: string;
};
const db = () => {
  const value = mongoose.connection.db;
  if (!value) throw Error("Owned database required");
  return value;
};
const record = async (value: object) => {
  const path = process.env["BOOKLY_PROOF_EVIDENCE_PATH"];
  if (path) await appendFile(path, `${JSON.stringify(value)}\n`);
};
const setup = async () => {
  const quote = probeQuote(
    {
      claimId: "claim",
      quoteId: "quote",
      businessId: "business",
      businessClientId: "client-A",
      customerId: "customer",
      originBookingId: "origin",
      batchId: "batch",
      progressId: "progress",
      termsHash: "terms",
      disclosureHash: "disclosure",
      selectionHash: "selection",
    },
    1_700_000_000_000n * NS_PER_MS,
  );
  const consent = {
    quoteHash: probeDigest(quote),
    eventId: "event",
    acceptanceId: "acceptance",
    familyId: "family",
    actionHash: "affirmative-action",
  };
  const rows = db().collection<Row>("certificate_protocol_probe");
  await rows.insertOne({ _id: "claim", quote });
  const signer = syntheticIntervalSigner();
  const trace: string[] = [];
  const persist = async () => {
    const session = await mongoose.startSession({ causalConsistency: true });
    try {
      await session.withTransaction(
        async () => {
          expect(
            (
              await rows.updateOne(
                { _id: "claim", consent: { $exists: false } },
                { $set: { consent } },
                { session },
              )
            ).matchedCount,
          ).toBe(1);
        },
        { readConcern: { level: "snapshot" }, writeConcern: { w: "majority", j: true } },
      );
      trace.push("majority+journal-commit-acknowledged");
      return session.operationTime;
    } finally {
      await session.endSession();
    }
  };
  const readWitness = async (session: ClientSession) => {
    if (session.inTransaction()) throw Error("Uncommitted snapshot is not a durability barrier");
    const row = await rows.findOne(
      { _id: "claim" },
      { session, readConcern: { level: "majority" }, readPreference: "primary", maxTimeMS: 2000 },
    );
    if (
      !row?.consent ||
      probeDigest(row.quote) !== probeDigest(quote) ||
      probeDigest(row.consent) !== probeDigest(consent)
    )
      throw Error("No exact canonical durable winner");
    trace.push("outside-transaction-majority-read-exact-winner");
    if (row.witness) {
      expect(row.witness.quoteHash).toBe(probeDigest(quote));
      expect(row.witness.consentHash).toBe(probeDigest(consent));
      trace.push("recover-exact-original-witness-no-new-nonce");
      return row.witness;
    }
    const witness = probeWitness(
      quote,
      consent,
      session.operationTime?.toString() ?? "MAJORITY_EXACT_ROW",
    );
    trace.push("fresh-witness-generated-after-read");
    await rows.updateOne(
      { _id: "claim", quote, consent, witness: { $exists: false } },
      { $set: { witness } },
      { session, writeConcern: { w: "majority", j: true } },
    );
    const winner = await rows.findOne(
      { _id: "claim" },
      { session, readConcern: { level: "majority" }, readPreference: "primary", maxTimeMS: 2000 },
    );
    if (!winner?.witness) throw Error("Witness persistence unresolved");
    expect(winner.witness.quoteHash).toBe(probeDigest(quote));
    expect(winner.witness.consentHash).toBe(probeDigest(consent));
    trace.push("exact-witness-majority-durable-before-observation-request");
    return winner.witness;
  };
  return {
    quote,
    consent,
    rows,
    signer,
    trace,
    persist,
    readWitness,
    d: BigInt(quote.deadlineMs) * NS_PER_MS,
  };
};

it("PROOF-01/02/07/11: exact majority-read barrier, conditional token, immutable replay and one consumption probe", async () => {
  const s = await setup(),
    operationTime = await s.persist();
  const reader = await mongoose.startSession({ causalConsistency: true });
  try {
    if (!operationTime) throw Error("Committed operation time required in this experiment");
    reader.advanceOperationTime(operationTime);
    const witness = await s.readWitness(reader),
      token = s.signer.issue(witness, s.d - 2n * NS_PER_MS, s.d - NS_PER_MS);
    expect(conditionalProbeCheck(s.quote, s.consent, witness, token, s.signer.publicKey)).toBe(
      "CONDITIONAL_BOUND_SATISFIED",
    );
    const save = () =>
      s.rows.updateOne(
        { _id: "claim", consent: s.consent, certificate: { $exists: false } },
        { $set: { certificate: token } },
        { writeConcern: { w: "majority", j: true } },
      );
    expect((await save()).modifiedCount).toBe(1);
    expect((await save()).modifiedCount).toBe(0);
    const stored = await s.rows.findOne({ _id: "claim" });
    expect(stored?.certificate).toEqual(token);
    expect(await s.readWitness(reader)).toEqual(witness);
    const consume = () =>
      s.rows.updateOne(
        {
          _id: "claim",
          "quote.identity.batchId": "batch",
          certificate: token,
          consumedBy: { $exists: false },
        },
        { $set: { consumedBy: "batch" } },
      );
    const results = await Promise.all([consume(), consume()]);
    expect(results.reduce((n, r) => n + r.modifiedCount, 0)).toBe(1);
    expect(
      (
        await s.rows.updateOne(
          { _id: "claim", "quote.identity.batchId": "FOREIGN" },
          { $set: { consumedBy: "FOREIGN" } },
        )
      ).matchedCount,
    ).toBe(0);
    await record({
      experiment: "POST_COMMIT_BARRIER_AND_BINDING",
      trace: s.trace,
      conditionalResult: "SATISFIED_UNDER_ASSUMED_TIME_ONLY",
      actualF2ConsumptionTested: false,
      timeAuthority: "SYNTHETIC_NOT_TRUSTED",
      operationTime,
    });
  } finally {
    await reader.endSession();
  }
});

it("PROOF-04: a token obtained before the durable barrier cannot substitute for a fresh witness", async () => {
  const s = await setup();
  const early = probeWitness(s.quote, s.consent, "PRECOMMIT_NOT_A_BARRIER");
  const stale = s.signer.issue(early, s.d - 3n, s.d - 2n);
  await s.persist();
  const reader = await mongoose.startSession({ causalConsistency: true });
  try {
    const fresh = await s.readWitness(reader);
    expect(() =>
      conditionalProbeCheck(s.quote, s.consent, fresh, stale, s.signer.publicKey),
    ).toThrow("witness");
    await record({
      experiment: "STALE_OBSERVATION_REJECTED",
      freshNonceDiffers: early.nonce !== fresh.nonce,
      timeAuthority: "SYNTHETIC",
    });
  } finally {
    await reader.endSession();
  }
});

it("PROOF-06/09: lost app response after actual commit stays uncertified when only a later bound exists", async () => {
  const s = await setup();
  await expect(
    (async () => {
      await s.persist();
      throw Error("CONTROLLED_LOST_APPLICATION_RESPONSE");
    })(),
  ).rejects.toThrow("CONTROLLED");
  expect((await s.rows.findOne({ _id: "claim" }))?.certificate).toBeUndefined();
  const reader = await mongoose.startSession({ causalConsistency: true });
  try {
    const witness = await s.readWitness(reader),
      late = s.signer.issue(witness, s.d, s.d + NS_PER_MS);
    expect(conditionalProbeCheck(s.quote, s.consent, witness, late, s.signer.publicKey)).toBe(
      "REFUSE_UNCERTAIN_OR_LATE_BOUND",
    );
    expect((await s.rows.findOne({ _id: "claim" }))?.consent).toEqual(s.consent);
    expect((await s.rows.findOne({ _id: "claim" }))?.certificate).toBeUndefined();
    await record({
      experiment: "LOST_APP_RESPONSE_WITH_REAL_COMMIT",
      actualCommitWireLoss: false,
      outcome: "DURABLE_UNCERTIFIED_REFUSED_NEW_LATE_OBSERVATION",
      quoteUnchanged: true,
    });
  } finally {
    await reader.endSession();
  }
});

it("PROOF-08: conflicting actions cannot both occupy the same immutable canonical consent slot", async () => {
  const s = await setup(),
    other = { ...s.consent, eventId: "conflicting-event" };
  const results = await Promise.all(
    [s.consent, other].map((consent) =>
      s.rows.updateOne(
        { _id: "claim", quote: s.quote, consent: { $exists: false } },
        { $set: { consent } },
        { writeConcern: { w: "majority", j: true } },
      ),
    ),
  );
  expect(results.reduce((n, r) => n + r.modifiedCount, 0)).toBe(1);
  expect(await s.rows.countDocuments()).toBe(1);
  await record({
    experiment: "REAL_CANONICAL_CAS_ELECTION",
    winners: 1,
    productionConsentRowsCreated: 0,
  });
});

it("PROOF-02: a staged transaction read is refused and abort leaves no consent probe", async () => {
  const s = await setup(),
    session = await mongoose.startSession();
  try {
    session.startTransaction();
    await s.rows.updateOne({ _id: "claim" }, { $set: { consent: s.consent } }, { session });
    await expect(s.readWitness(session)).rejects.toThrow("snapshot");
    await session.abortTransaction();
    expect((await s.rows.findOne({ _id: "claim" }))?.consent).toBeUndefined();
  } finally {
    if (session.inTransaction()) await session.abortTransaction();
    await session.endSession();
  }
});

it.each([false, true])(
  "PROOF-03/12: native session revocation race, shared write fence=%s",
  async (fenced) => {
    const s = await setup();
    const family = "proof-family",
      userId = new Types.ObjectId();
    const native = await SessionModel.create({
      userId,
      refreshTokenHash: "synthetic-probe-hash",
      tokenFamilyId: family,
      expiresAt: new Date("2040-01-01T00:00:00Z"),
    });
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const before = await SessionModel.findById(native._id).session(session).orFail();
      expect(before.revokedAt).toBeUndefined();
      await new SessionRepository().revokeFamily(family);
      if (fenced) {
        const version = before.revocationVersion;
        if (version === undefined) throw Error("Native session revocation version required");
        await expect(
          SessionModel.updateOne(
            {
              _id: native._id,
              revokedAt: { $exists: false },
              revocationVersion: version,
            },
            { $set: { lastUsedAt: new Date() } },
            { session },
          ),
        ).rejects.toMatchObject({ code: 112 });
        await session.abortTransaction();
        expect((await s.rows.findOne({ _id: "claim" }))?.consent).toBeUndefined();
      } else {
        await s.rows.updateOne({ _id: "claim" }, { $set: { consent: s.consent } }, { session });
        await session.commitTransaction();
        expect((await s.rows.findOne({ _id: "claim" }))?.consent).toEqual(s.consent);
      }
      expect((await SessionModel.findById(native._id).orFail()).revokedAt).toBeInstanceOf(Date);
      await record({
        experiment: "ACTUAL_SOURCE_SESSION_REVOKER_RACE",
        fenced,
        result: fenced ? "REAL_112_ABORT" : "READ_ONLY_AUTH_CHECK_PERMITS_LATER_COMMIT",
        policyLiveAtCNotYetApproved: true,
      });
    } finally {
      if (session.inTransaction()) await session.abortTransaction();
      await session.endSession();
    }
  },
);

it("PROOF-10: unique current relationship lookup does not freeze the original BusinessClient identity", async () => {
  const s = await setup();
  const clients = db().collection<{ _id: string; businessId: string; linkedUserId?: string }>(
    "relationship_identity_probe",
  );
  await clients.createIndex(
    { businessId: 1, linkedUserId: 1 },
    { unique: true, partialFilterExpression: { linkedUserId: { $exists: true } } },
  );
  await clients.insertOne({ _id: "client-A", businessId: "business", linkedUserId: "customer" });
  await clients.updateOne({ _id: "client-A" }, { $unset: { linkedUserId: "" } });
  await clients.insertOne({ _id: "client-B", businessId: "business", linkedUserId: "customer" });
  expect((await clients.findOne({ businessId: "business", linkedUserId: "customer" }))?._id).toBe(
    "client-B",
  );
  const exact = await clients.findOne({
    _id: s.quote.identity.businessClientId,
    businessId: "business",
    linkedUserId: "customer",
  });
  expect(exact).toBeNull();
  expect((await s.rows.findOne({ _id: "claim" }))?.quote.identity.businessClientId).toBe(
    "client-A",
  );
  await record({
    experiment: "BUSINESSCLIENT_UNIQUE_PAIR_NOT_HISTORICAL_IDENTITY",
    current: "client-B",
    pinned: "client-A",
    exactOriginalLinkMissing: true,
    newIdentityNotAdopted: true,
  });
});
it("PROOF-06: injected observation outage yields no witness or certification", async () => {
  const s = await setup();
  await s.persist();
  const reader = await mongoose.startSession({ causalConsistency: true });
  try {
    const failure = vi
      .spyOn(s.rows, "findOne")
      .mockRejectedValueOnce(new Error("INJECTED_OBSERVATION_OUTAGE"));
    await expect(s.readWitness(reader)).rejects.toThrow("INJECTED");
    failure.mockRestore();
    expect(s.trace).not.toContain("fresh-witness-generated-after-read");
    expect((await s.rows.findOne({ _id: "claim" }))?.certificate).toBeUndefined();
    await record({
      experiment: "INJECTED_OBSERVATION_OUTAGE",
      actualWireFault: false,
      result: "NO_WITNESS_NO_CERTIFICATE",
    });
  } finally {
    await reader.endSession();
  }
});
