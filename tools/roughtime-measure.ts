/**
 * P1B — Roughtime public-server measurement harness. TRUSTED HOST ONLY.
 *
 *   npx tsx tools/roughtime-measure.ts [--out report.json] [--timeout-ms 3000]
 *
 * Sends ONLY random nonces and zero padding (RFC 10049 version-1 requests). No Bookly customer,
 * booking, business or consent data is used. Outside `src/`: never built, never shipped.
 * Run only after the operator confirms network access and the servers' usage terms
 * (time.txryan.com asks to be contacted before high-volume infrastructure use).
 *
 * Phase A: one independent query per server (availability, version, latency, RADI, validity).
 * Phase B: the RFC 10049 §8.2 chained sequence, twice in the same order, over Phase-A
 * responders, then the f-tolerant quorum evaluation. Results are printed as JSON; nothing is
 * inferred for servers that did not answer.
 */
import { createSocket } from "node:dgram";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import {
  chainedNonce,
  evaluateRoughtimeQuorum,
  freshRand,
  type RoughtimeEvidenceEntry,
  type RoughtimeServerPin,
  witnessNonce,
} from "../src/modules/booking/trusted-time/roughtime-quorum.js";
import {
  ROUGHTIME_MEASUREMENT_CANDIDATES,
  type RoughtimeCandidate,
} from "../src/modules/booking/trusted-time/roughtime-servers.js";
import { verifyRoughtimeResponse } from "../src/modules/booking/trusted-time/roughtime-verify.js";
import { buildRequestPacket } from "../src/modules/booking/trusted-time/roughtime-wire.js";

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const TIMEOUT_MS = Number(argument("--timeout-ms") ?? 3000);
const OUT = argument("--out");
const MAX_ATTEMPTS = 3; // RFC 10049 §5: exponential backoff, initial 1 s, base 1.5.

const keyOf = (c: RoughtimeCandidate) => Buffer.from(c.publicKeyBase64, "base64");

const queryOnce = (c: RoughtimeCandidate, request: Buffer) =>
  new Promise<{ response: Buffer; roundTripMs: number } | null>((resolve) => {
    const socket = createSocket("udp4");
    const started = performance.now();
    const timer = setTimeout(() => {
      socket.close();
      resolve(null);
    }, TIMEOUT_MS);
    socket.once("message", (message) => {
      clearTimeout(timer);
      socket.close();
      resolve({ response: message, roundTripMs: performance.now() - started });
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.close();
      resolve(null);
    });
    socket.send(request, c.port, c.host);
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const query = async (c: RoughtimeCandidate, request: Buffer) => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await queryOnce(c, request);
    if (result) return { ...result, attempts: attempt };
    if (attempt < MAX_ATTEMPTS) await sleep(1000 * 1.5 ** (attempt - 1));
  }
  return null;
};

const main = async () => {
  const startedAt = new Date().toISOString();
  const phaseA = [];
  for (const c of ROUGHTIME_MEASUREMENT_CANDIDATES) {
    const request = buildRequestPacket(freshRand(), keyOf(c));
    const answer = await query(c, request);
    const verification = answer
      ? verifyRoughtimeResponse({
          requestPacket: request,
          responsePacket: answer.response,
          longTermPublicKey: keyOf(c),
        })
      : null;
    phaseA.push({
      serverId: c.serverId,
      operatorId: c.operatorId,
      address: `${c.host}:${c.port}`,
      responded: Boolean(answer),
      attempts: answer?.attempts ?? MAX_ATTEMPTS,
      roundTripMs: answer ? Math.round(answer.roundTripMs) : null,
      responseBytes: answer?.response.length ?? null,
      valid: verification?.ok ?? false,
      rejection: verification && !verification.ok ? verification.reason : null,
      radiusSeconds: verification?.ok ? verification.radiusSeconds : null,
      // Local-clock difference is diagnostic only; it is never evidence.
      midpointMinusLocalMs: verification?.ok
        ? verification.midpointSeconds * 1000 - Date.now()
        : null,
    });
  }

  const responders = ROUGHTIME_MEASUREMENT_CANDIDATES.filter(
    (c) => phaseA.find((a) => a.serverId === c.serverId)?.valid,
  );
  const pins: RoughtimeServerPin[] = responders.map((c) => ({
    serverId: c.serverId,
    operatorId: c.operatorId,
    longTermPublicKey: keyOf(c),
  }));
  const witnessDigest = freshRand(); // random: measurement only, no Bookly data
  const evidence: RoughtimeEvidenceEntry[] = [];
  let chainBroken: string | null = null;
  const phaseBFirstSendMs = Date.now(); // local clock: diagnostic only, never evidence
  for (let round = 0; round < 2 && !chainBroken; round += 1)
    for (const c of responders) {
      const rand = freshRand();
      const previous = evidence.at(-1);
      const nonce = previous
        ? chainedNonce(previous.responsePacket, rand)
        : witnessNonce(witnessDigest, rand);
      const request = buildRequestPacket(nonce, keyOf(c));
      const answer = await query(c, request);
      if (!answer) {
        chainBroken = c.serverId;
        break;
      }
      evidence.push({
        serverId: c.serverId,
        rand,
        requestPacket: request,
        responsePacket: answer.response,
        roundTripMs: answer.roundTripMs,
      });
    }
  const quorum = chainBroken
    ? { kind: "UNRESOLVED", reason: "NO_RESPONSE_IN_CHAIN", detail: chainBroken }
    : evaluateRoughtimeQuorum({
        witnessDigest,
        evidence,
        pins,
        policy: {
          faultTolerance: 1,
          minIndependentOperators: 3,
          rounds: 2,
          maxRoundTripMs: TIMEOUT_MS,
        },
      });

  const report = {
    tool: "bookly-p1b-roughtime-measure",
    startedAt,
    finishedAt: new Date().toISOString(),
    timeoutMs: TIMEOUT_MS,
    phaseA,
    phaseB: {
      servers: responders.map((c) => c.serverId),
      entries: evidence.length,
      quorum:
        quorum.kind === "QUORUM"
          ? {
              kind: quorum.kind,
              operators: quorum.operators,
              lowerBoundMs: quorum.lowerBoundMs,
              upperBoundMs: quorum.upperBoundMs,
              // Width of the commit-direction bound relative to when the first nonce was sent.
              upperBoundMinusFirstSendMs: quorum.upperBoundMs - phaseBFirstSendMs,
            }
          : quorum,
      // Raw evidence for offline re-verification.
      evidence: evidence.map((e) => ({
        serverId: e.serverId,
        rand: e.rand.toString("base64"),
        request: e.requestPacket.toString("base64"),
        response: e.responsePacket.toString("base64"),
      })),
    },
  };
  const json = JSON.stringify(report, null, 2);
  if (OUT) writeFileSync(OUT, json);
  process.stdout.write(`${json}\n`);
};

await main();
