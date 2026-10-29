import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import { APPROVED_CONSENT_TIME_AUTHORITIES } from "../../src/modules/booking/package-consent-commit-deadline.js";
import { chronyClockBound } from "../../src/modules/booking/trusted-time/chrony-bound.js";
import {
  assessCommitWithDualAuthority,
  combineDualAuthority,
  consentCommitWitnessDigest,
  DUAL_AUTHORITY_ID,
} from "../../src/modules/booking/trusted-time/dual-authority.js";
import {
  chainedNonce,
  evaluateRoughtimeQuorum,
  freshRand,
  type QuorumResult,
  type RoughtimeEvidenceEntry,
  type RoughtimeServerPin,
  witnessNonce,
} from "../../src/modules/booking/trusted-time/roughtime-quorum.js";
import { ROUGHTIME_MEASUREMENT_CANDIDATES } from "../../src/modules/booking/trusted-time/roughtime-servers.js";
import {
  merkleRootMatches,
  verifyRoughtimeResponse,
} from "../../src/modules/booking/trusted-time/roughtime-verify.js";
import {
  buildRequestPacket,
  decodeMessage,
  decodePacket,
  encodeMessage,
  encodePacket,
  ROUGHTIME_MIN_REQUEST_MESSAGE_BYTES,
  RoughtimeFormatError,
  roughtimeHash,
  uint32,
  uint64,
} from "../../src/modules/booking/trusted-time/roughtime-wire.js";

/**
 * P1B — synthetic, in-test Roughtime servers (Ed25519 keys generated per run). These tests
 * exercise the RFC 10049 version-1 verification and quorum logic. They are NOT measurements of
 * any public server and prove nothing about real server honesty or availability.
 */

const RESPONSE_CONTEXT = Buffer.from("Roughtime v1 response signature\0", "latin1");
const DELEGATION_CONTEXT = Buffer.from("Roughtime v1 delegation signature\0", "latin1");
const T0 = 1_793_000_000; // seconds, synthetic

const raw = (key: KeyObject) => key.export({ format: "der", type: "spki" }).subarray(12);

type SyntheticServer = {
  ltPublic: Buffer;
  ltPrivate: KeyObject;
  delPrivate: KeyObject;
  delPublic: Buffer;
};
const makeServer = (): SyntheticServer => {
  const lt = generateKeyPairSync("ed25519");
  const del = generateKeyPairSync("ed25519");
  return {
    ltPublic: raw(lt.publicKey),
    ltPrivate: lt.privateKey,
    delPrivate: del.privateKey,
    delPublic: raw(del.publicKey),
  };
};

type Options = {
  midp?: number;
  radi?: number;
  mint?: number;
  maxt?: number;
  type?: number;
  ver?: number;
  vers?: number[];
  nonce?: Buffer;
  /** Other requests batched into the same Merkle tree (power-of-two total). */
  batch?: Buffer[];
  index?: number;
  tamperPath?: boolean;
  indexOverride?: number;
  signWithLongTermKeyOf?: SyntheticServer;
  tamperSrepAfterSigning?: boolean;
  extraBytes?: number;
};

const merkle = (leaves: Buffer[], index: number) => {
  let level = leaves.map((leaf) => roughtimeHash(Buffer.from([0x00]), leaf));
  const path: Buffer[] = [];
  let i = index;
  while (level.length > 1) {
    path.push(level[i ^ 1] as Buffer);
    const next: Buffer[] = [];
    for (let k = 0; k < level.length; k += 2)
      next.push(roughtimeHash(Buffer.from([0x01]), level[k] as Buffer, level[k + 1] as Buffer));
    level = next;
    i >>= 1;
  }
  return { root: level[0] as Buffer, path: Buffer.concat(path) };
};

const respond = (server: SyntheticServer, request: Buffer, o: Options = {}): Buffer => {
  const nonce = o.nonce ?? decodeMessage(decodePacket(request)).get("NONC");
  const index = o.index ?? 0;
  const leaves = [...(o.batch ?? [])];
  leaves.splice(index, 0, request);
  const { root, path } = merkle(leaves, index);
  const midp = BigInt(o.midp ?? T0);
  let srep = encodeMessage([
    ["VER", uint32(o.ver ?? 1)],
    ["RADI", uint32(o.radi ?? 1)],
    ["MIDP", uint64(midp)],
    ["VERS", Buffer.concat((o.vers ?? [1]).map(uint32))],
    ["ROOT", root],
  ]);
  const dele = encodeMessage([
    ["PUBK", server.delPublic],
    ["MINT", uint64(BigInt(o.mint ?? T0 - 86_400))],
    ["MAXT", uint64(BigInt(o.maxt ?? T0 + 86_400))],
  ]);
  const certSigner = o.signWithLongTermKeyOf ?? server;
  const cert = encodeMessage([
    ["SIG", sign(null, Buffer.concat([DELEGATION_CONTEXT, dele]), certSigner.ltPrivate)],
    ["DELE", dele],
  ]);
  const srepSig = sign(null, Buffer.concat([RESPONSE_CONTEXT, srep]), server.delPrivate);
  if (o.tamperSrepAfterSigning)
    srep = encodeMessage([
      ["VER", uint32(1)],
      ["RADI", uint32(o.radi ?? 1)],
      ["MIDP", uint64(midp + 3600n)],
      ["VERS", uint32(1)],
      ["ROOT", root],
    ]);
  const tamperedPath = o.tamperPath && path.length > 0 ? Buffer.from(path) : path;
  if (o.tamperPath && tamperedPath.length > 0) tamperedPath[0] = (tamperedPath[0] as number) ^ 1;
  const message = encodeMessage([
    ["SIG", srepSig],
    ["NONC", nonce as Buffer],
    ["TYPE", uint32(o.type ?? 1)],
    ["PATH", tamperedPath],
    ["SREP", srep],
    ["CERT", cert],
    ["INDX", uint32(o.indexOverride ?? index)],
    ...(o.extraBytes ? ([["ZZZZ", Buffer.alloc(o.extraBytes)]] as Array<[string, Buffer]>) : []),
  ]);
  return encodePacket(message);
};

const ask = (server: SyntheticServer, o: Options = {}) => {
  const request = buildRequestPacket(freshRand(), server.ltPublic);
  return { request, response: respond(server, request, o) };
};

const check = (server: SyntheticServer, o: Options = {}, key = server.ltPublic) => {
  const { request, response } = ask(server, o);
  return verifyRoughtimeResponse({
    requestPacket: request,
    responsePacket: response,
    longTermPublicKey: key,
  });
};

describe("RFC 10049 wire format", () => {
  it("builds a version-1 request padded to ≥ 1024 bytes with sorted tags", () => {
    const server = makeServer();
    const packet = buildRequestPacket(freshRand(), server.ltPublic);
    const message = decodePacket(packet);
    expect(message.length).toBeGreaterThanOrEqual(ROUGHTIME_MIN_REQUEST_MESSAGE_BYTES);
    const decoded = decodeMessage(message);
    expect([...decoded.keys()]).toEqual(["VER", "SRV", "NONC", "TYPE", "ZZZZ"]);
    expect(decoded.get("VER")?.readUInt32LE(0)).toBe(1);
    expect(decoded.get("TYPE")?.readUInt32LE(0)).toBe(0);
    expect(decoded.get("SRV")).toEqual(roughtimeHash(Buffer.from([0xff]), server.ltPublic));
    expect(decoded.get("ZZZZ")?.every((b) => b === 0)).toBe(true);
  });

  it("rejects malformed packets and messages", () => {
    const good = encodePacket(encodeMessage([["NONC", Buffer.alloc(32)]]));
    expect(() => decodePacket(Buffer.concat([Buffer.from("ROUGHTIX"), good.subarray(8)]))).toThrow(
      RoughtimeFormatError,
    );
    expect(() => decodePacket(good.subarray(0, good.length - 1))).toThrow(RoughtimeFormatError);
    expect(() => decodePacket(Buffer.alloc(4))).toThrow(RoughtimeFormatError);
    // Two tags in descending order.
    const unsorted = Buffer.concat([
      uint32(2),
      uint32(4),
      Buffer.from("TYPE"),
      Buffer.from("NONC"),
      Buffer.alloc(8),
    ]);
    expect(() => decodeMessage(unsorted)).toThrow(RoughtimeFormatError);
    // Unaligned offset.
    const unaligned = Buffer.concat([
      uint32(2),
      uint32(3),
      Buffer.from("NONC"),
      Buffer.from("TYPE"),
      Buffer.alloc(8),
    ]);
    expect(() => decodeMessage(unaligned)).toThrow(RoughtimeFormatError);
    // Header claims more pairs than the message holds.
    expect(() => decodeMessage(Buffer.concat([uint32(1000), Buffer.alloc(8)]))).toThrow(
      RoughtimeFormatError,
    );
    expect(() =>
      encodeMessage([
        ["NONC", Buffer.alloc(4)],
        ["NONC", Buffer.alloc(4)],
      ]),
    ).toThrow();
  });
});

describe("response validity (RFC 10049 §5.4)", () => {
  it("accepts a valid response and reports the interval conservatively in ms", () => {
    const result = check(makeServer(), { midp: T0, radi: 2 });
    expect(result).toMatchObject({
      ok: true,
      midpointSeconds: T0,
      radiusSeconds: 2,
      earliestMs: (T0 - 2) * 1000,
      latestMs: (T0 + 2) * 1000,
    });
  });

  it.each([1, 2, 3])("accepts a batched Merkle proof at index %i of 4", (index) => {
    const server = makeServer();
    const others = [0, 1, 2].map(() => buildRequestPacket(freshRand(), server.ltPublic));
    expect(check(server, { batch: others, index }).ok).toBe(true);
  });

  it.each([
    [
      "wrong pinned long-term key",
      () => check(makeServer(), {}, makeServer().ltPublic),
      "DELEGATION_SIGNATURE_INVALID",
    ],
    [
      "delegation signed by another key",
      () => check(makeServer(), { signWithLongTermKeyOf: makeServer() }),
      "DELEGATION_SIGNATURE_INVALID",
    ],
    [
      "SREP altered after signing",
      () => check(makeServer(), { tamperSrepAfterSigning: true }),
      "RESPONSE_SIGNATURE_INVALID",
    ],
    ["MIDP before MINT", () => check(makeServer(), { mint: T0 + 1 }), "OUTSIDE_DELEGATION_WINDOW"],
    ["MIDP after MAXT", () => check(makeServer(), { maxt: T0 - 1 }), "OUTSIDE_DELEGATION_WINDOW"],
    [
      "another request's nonce",
      () => check(makeServer(), { nonce: freshRand() }),
      "NONCE_MISMATCH",
    ],
    ["TYPE 0", () => check(makeServer(), { type: 0 }), "NOT_A_RESPONSE"],
    ["version 2", () => check(makeServer(), { ver: 2, vers: [2] }), "UNSUPPORTED_VERSION"],
    ["VERS without 1", () => check(makeServer(), { vers: [2] }), "UNSUPPORTED_VERSION"],
    ["zero radius", () => check(makeServer(), { radi: 0 }), "INVALID_RADIUS"],
  ] as const)("rejects %s", (_name, run, reason) => {
    expect(run()).toEqual({ ok: false, reason });
  });

  it("rejects a corrupted Merkle path and extra INDX bits", () => {
    const server = makeServer();
    const others = [0, 1, 2].map(() => buildRequestPacket(freshRand(), server.ltPublic));
    expect(check(server, { batch: others, index: 1, tamperPath: true })).toEqual({
      ok: false,
      reason: "MERKLE_PROOF_INVALID",
    });
    expect(check(server, { indexOverride: 4 })).toEqual({
      ok: false,
      reason: "MERKLE_PROOF_INVALID",
    });
  });

  it("rejects PATH longer than 32 nodes and responses larger than the request", () => {
    expect(merkleRootMatches(Buffer.alloc(1), Buffer.alloc(33 * 32), 0, Buffer.alloc(32))).toBe(
      false,
    );
    expect(check(makeServer(), { extraBytes: 2048 })).toEqual({
      ok: false,
      reason: "RESPONSE_LARGER_THAN_REQUEST",
    });
  });

  it("treats garbage as malformed, never as time", () => {
    const server = makeServer();
    const request = buildRequestPacket(freshRand(), server.ltPublic);
    expect(
      verifyRoughtimeResponse({
        requestPacket: request,
        responsePacket: Buffer.from("ROUGHTIM\0\0\0\0"),
        longTermPublicKey: server.ltPublic,
      }),
    ).toEqual({ ok: false, reason: "MALFORMED" });
  });
});

/** Runs a chained 2-round sequence; `timeOf(serverIndex)` gives each server's (honest or not) MIDP. */
const runSequence = (
  servers: SyntheticServer[],
  ids: string[],
  witness: Buffer,
  timeOf: (serverIndex: number, step: number) => number,
  rounds = 2,
) => {
  const evidence: RoughtimeEvidenceEntry[] = [];
  let step = 0;
  for (let round = 0; round < rounds; round += 1)
    servers.forEach((server, i) => {
      const rand = freshRand();
      const previous = evidence.at(-1);
      const nonce = previous
        ? chainedNonce(previous.responsePacket, rand)
        : witnessNonce(witness, rand);
      const requestPacket = buildRequestPacket(nonce, server.ltPublic);
      evidence.push({
        serverId: ids[i] as string,
        rand,
        requestPacket,
        responsePacket: respond(server, requestPacket, { midp: timeOf(i, step), radi: 1 }),
        roundTripMs: 40,
      });
      step += 1;
    });
  return evidence;
};

const pinsFor = (
  servers: SyntheticServer[],
  ids: string[],
  operators = ids,
): RoughtimeServerPin[] =>
  servers.map((s, i) => ({
    serverId: ids[i] as string,
    operatorId: operators[i] as string,
    longTermPublicKey: s.ltPublic,
  }));

describe("multi-server quorum (RFC 10049 §8.2)", () => {
  const ids = ["a", "b", "c"];

  it("three honest operators, two rounds → f-tolerant interval containing the true time", () => {
    const servers = [makeServer(), makeServer(), makeServer()];
    const witness = freshRand();
    const evidence = runSequence(servers, ids, witness, (_i, step) => T0 + step);
    const result = evaluateRoughtimeQuorum({
      witnessDigest: witness,
      evidence,
      pins: pinsFor(servers, ids),
    });
    expect(result.kind).toBe("QUORUM");
    if (result.kind !== "QUORUM") return;
    expect(result.operators).toEqual(["a", "b", "c"]);
    // True processing times were T0+0 … T0+5. The upper bound (for events before the
    // sequence) is not below the first true time; the lower bound (for events after it) is
    // not above the last true time.
    expect(result.upperBoundMs).toBeGreaterThanOrEqual(T0 * 1000);
    expect(result.lowerBoundMs).toBeLessThanOrEqual((T0 + 5) * 1000);
    // (f+1)-th smallest per-operator minimum latest: a=T0+1, b=T0+2, c=T0+3 → T0+2.
    expect(result.upperBoundMs).toBe((T0 + 2) * 1000);
    // (f+1)-th largest per-operator maximum earliest: a=T0+2, b=T0+3, c=T0+4 → T0+3.
    expect(result.lowerBoundMs).toBe((T0 + 3) * 1000);
  });

  it("one operator lying far in the past cannot pull the upper bound below an honest server (f = 1)", () => {
    const servers = [makeServer(), makeServer(), makeServer()];
    const witness = freshRand();
    // Server b claims a time 1 hour early — but causal ordering then fails (detected).
    const evidence = runSequence(servers, ids, witness, (i, step) =>
      i === 1 ? T0 - 3600 : T0 + step,
    );
    expect(
      evaluateRoughtimeQuorum({ witnessDigest: witness, evidence, pins: pinsFor(servers, ids) }),
    ).toMatchObject({
      kind: "UNRESOLVED",
      reason: "CAUSALLY_INCONSISTENT",
    });
  });

  it("a server slightly low but causally consistent is out-voted by the (f+1)-th smallest bound", () => {
    const servers = [makeServer(), makeServer(), makeServer()];
    const witness = freshRand();
    // a = T0 (interval T0±1), b and c = T0+1: overlapping, so causally consistent.
    const evidence = runSequence(servers, ids, witness, (i) => (i === 0 ? T0 : T0 + 1));
    const result = evaluateRoughtimeQuorum({
      witnessDigest: witness,
      evidence,
      pins: pinsFor(servers, ids),
    });
    expect(result.kind).toBe("QUORUM");
    // Per-operator upper bounds: a=T0+1, b=T0+2, c=T0+2 → the low server alone cannot decide.
    if (result.kind === "QUORUM") expect(result.upperBoundMs).toBe((T0 + 2) * 1000);
  });

  it("a server lagging beyond its radius is detected as causally inconsistent, not averaged", () => {
    const servers = [makeServer(), makeServer(), makeServer()];
    const witness = freshRand();
    const evidence = runSequence(servers, ids, witness, (i) => (i === 0 ? T0 - 1 : T0 + 2));
    expect(
      evaluateRoughtimeQuorum({ witnessDigest: witness, evidence, pins: pinsFor(servers, ids) }),
    ).toMatchObject({ kind: "UNRESOLVED", reason: "CAUSALLY_INCONSISTENT" });
  });

  it("refuses fewer than three independent operators (two servers of one operator count once)", () => {
    const servers = [makeServer(), makeServer(), makeServer()];
    const witness = freshRand();
    const evidence = runSequence(servers, ids, witness, () => T0);
    expect(
      evaluateRoughtimeQuorum({
        witnessDigest: witness,
        evidence,
        pins: pinsFor(servers, ids, ["x", "x", "y"]),
      }),
    ).toMatchObject({ kind: "UNRESOLVED", reason: "INSUFFICIENT_INDEPENDENT_OPERATORS" });
  });

  it("refuses evidence whose first nonce is not bound to this witness (e.g. generated before the commit)", () => {
    const servers = [makeServer(), makeServer(), makeServer()];
    const evidence = runSequence(servers, ids, freshRand(), () => T0);
    expect(
      evaluateRoughtimeQuorum({
        witnessDigest: freshRand(),
        evidence,
        pins: pinsFor(servers, ids),
      }),
    ).toMatchObject({ kind: "UNRESOLVED", reason: "NONCE_CHAIN_BROKEN" });
  });

  it("refuses a broken chain, a reordered second round, unknown servers and a wrong pinned key", () => {
    const servers = [makeServer(), makeServer(), makeServer()];
    const witness = freshRand();
    const evidence = runSequence(servers, ids, witness, () => T0);
    const pins = pinsFor(servers, ids);
    const broken = evidence.map((e, k) => (k === 2 ? { ...e, rand: freshRand() } : e));
    expect(evaluateRoughtimeQuorum({ witnessDigest: witness, evidence: broken, pins }).kind).toBe(
      "UNRESOLVED",
    );
    const reordered = [
      ...evidence.slice(0, 3),
      evidence[4],
      evidence[3],
      evidence[5],
    ] as RoughtimeEvidenceEntry[];
    expect(
      evaluateRoughtimeQuorum({ witnessDigest: witness, evidence: reordered, pins }),
    ).toMatchObject({
      reason: "SEQUENCE_ORDER_INVALID",
    });
    expect(
      evaluateRoughtimeQuorum({ witnessDigest: witness, evidence, pins: pins.slice(0, 2) }),
    ).toMatchObject({
      reason: "UNKNOWN_SERVER",
    });
    const wrongKey = pins.map((p, i) =>
      i === 0 ? { ...p, longTermPublicKey: makeServer().ltPublic } : p,
    );
    expect(
      evaluateRoughtimeQuorum({ witnessDigest: witness, evidence, pins: wrongKey }),
    ).toMatchObject({
      reason: "RESPONSE_INVALID",
    });
  });

  it("refuses a slow round trip when a maximum is set", () => {
    const servers = [makeServer(), makeServer(), makeServer()];
    const witness = freshRand();
    const evidence = runSequence(servers, ids, witness, () => T0);
    expect(
      evaluateRoughtimeQuorum({
        witnessDigest: witness,
        evidence,
        pins: pinsFor(servers, ids),
        policy: { faultTolerance: 1, minIndependentOperators: 3, rounds: 2, maxRoundTripMs: 10 },
      }),
    ).toMatchObject({ reason: "ROUND_TRIP_TOO_LONG" });
  });
});

describe("chrony bound", () => {
  const sample = {
    systemClockMs: T0 * 1000,
    leapStatus: "Normal",
    systemTimeOffsetSeconds: -0.002,
    rootDelaySeconds: 0.02,
    rootDispersionSeconds: 0.005,
  };
  it("bounds the clock by |offset| + dispersion + delay/2 (+1 ms), rounded up", () => {
    expect(chronyClockBound(sample, 1000)).toEqual({
      kind: "BOUND",
      earliestMs: T0 * 1000 - 18,
      latestMs: T0 * 1000 + 18,
      errorMs: 18,
    });
  });
  it("refuses unsynchronised, invalid or too-uncertain samples", () => {
    expect(chronyClockBound({ ...sample, leapStatus: "Not synchronised" }, 1000).kind).toBe(
      "UNRESOLVED",
    );
    expect(chronyClockBound({ ...sample, rootDelaySeconds: Number.NaN }, 1000).kind).toBe(
      "UNRESOLVED",
    );
    expect(chronyClockBound(sample, 10)).toEqual({ kind: "UNRESOLVED", reason: "ERROR_TOO_LARGE" });
  });
});

describe("dual authority → P1A verifier (still inert)", () => {
  const Q = T0 * 1000;
  const D = Q + 1_800_000;
  const quorum = (lowerBoundMs: number, upperBoundMs: number): QuorumResult => ({
    kind: "QUORUM",
    lowerBoundMs,
    upperBoundMs,
    operators: ["a", "b", "c"],
    observations: [],
  });
  const chrony = (center: number) =>
    chronyClockBound(
      {
        systemClockMs: center,
        leapStatus: "Normal",
        systemTimeOffsetSeconds: 0,
        rootDelaySeconds: 0.01,
        rootDispersionSeconds: 0.001,
      },
      1000,
    );
  const input = (commitRoughtimeLatest: number, commitChronyCenter: number) => ({
    retainedIssuedAtMs: Q,
    retainedExpiresAtMs: D,
    issuance: { roughtime: quorum(Q - 2000, Q + 2000), chrony: chrony(Q) },
    commit: {
      roughtime: quorum(commitRoughtimeLatest - 4000, commitRoughtimeLatest),
      chrony: chrony(commitChronyCenter),
    },
  });

  it("shipped registry: always UNRESOLVED, even with perfect evidence", () => {
    expect(APPROVED_CONSENT_TIME_AUTHORITIES).toEqual([]);
    expect(assessCommitWithDualAuthority(input(D - 600_000, D - 600_000))).toEqual({
      kind: "UNRESOLVED",
      reason: "TIME_AUTHORITY_NOT_APPROVED",
    });
  });

  it("synthetic registry: certifies only when BOTH sources put the commit before the deadline", () => {
    const reg = [DUAL_AUTHORITY_ID];
    expect(assessCommitWithDualAuthority(input(D - 600_000, D - 600_000), reg).kind).toBe(
      "CERTIFIED",
    );
    expect(assessCommitWithDualAuthority(input(D - 600_000, D + 1_000), reg)).toEqual({
      kind: "UNRESOLVED",
      reason: "COMMIT_NOT_PROVEN_BEFORE_DEADLINE",
    });
    expect(assessCommitWithDualAuthority(input(D + 1_000, D - 600_000), reg).kind).toBe(
      "UNRESOLVED",
    );
  });

  it("an unavailable source means no evidence, never a guess", () => {
    expect(combineDualAuthority(undefined, chrony(Q), "COMMIT")).toMatchObject({
      kind: "UNAVAILABLE",
      roughtime: "MISSING",
    });
    expect(
      assessCommitWithDualAuthority(
        { ...input(D - 600_000, D - 600_000), commit: { chrony: chrony(D - 600_000) } },
        [DUAL_AUTHORITY_ID],
      ),
    ).toEqual({ kind: "UNRESOLVED", reason: "NO_COMMIT_EVIDENCE" });
  });

  it("issuance anchors at the earlier of both lower bounds (never later than retained issuedAt)", () => {
    const result = assessCommitWithDualAuthority(input(D - 3_000, D - 600_000), [
      DUAL_AUTHORITY_ID,
    ]);
    // Roughtime issuance lower bound Q−2000 shortens the window: D−3000 is no longer < D−2000.
    expect(result).toEqual({ kind: "UNRESOLVED", reason: "COMMIT_NOT_PROVEN_BEFORE_DEADLINE" });
  });
});

describe("candidate servers and witness digest", () => {
  it("no candidate server is production-approved", () => {
    expect(ROUGHTIME_MEASUREMENT_CANDIDATES.every((c) => c.productionApproved === false)).toBe(
      true,
    );
    expect(
      ROUGHTIME_MEASUREMENT_CANDIDATES.every(
        (c) => Buffer.from(c.publicKeyBase64, "base64").length === 32,
      ),
    ).toBe(true);
  });

  it("the witness digest is deterministic, order-independent and 32 bytes", () => {
    const a = consentCommitWitnessDigest({ claimId: "c1", quoteTermsHash: "h1", eventId: "e1" });
    const b = consentCommitWitnessDigest({ eventId: "e1", claimId: "c1", quoteTermsHash: "h1" });
    expect(a.equals(b)).toBe(true);
    expect(a).toHaveLength(32);
    expect(
      consentCommitWitnessDigest({ claimId: "c2", quoteTermsHash: "h1", eventId: "e1" }).equals(a),
    ).toBe(false);
  });
});
