import { createPublicKey, verify as verifySignature } from "node:crypto";

import {
  decodeMessage,
  decodePacket,
  ROUGHTIME_VERSION_1,
  readUint32,
  readUint64,
  required,
  roughtimeHash,
} from "./roughtime-wire.js";

/**
 * P1B — RFC 10049 §5.4 response validity, version 1 only. Pure: no network, no clock.
 *
 * A VALID response proves only that the holder of the pinned long-term key signed
 * (MIDP-RADI, MIDP+RADI) for a request containing our nonce, i.e. after the nonce existed.
 * It does not prove the time is correct (RFC 10049 §5.4); that needs a quorum (§8.2).
 */

const RESPONSE_CONTEXT = Buffer.from("Roughtime v1 response signature\0", "latin1");
const DELEGATION_CONTEXT = Buffer.from("Roughtime v1 delegation signature\0", "latin1");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_PATH_NODES = 32;

export type RoughtimeRejection =
  | "MALFORMED"
  | "NOT_A_RESPONSE"
  | "NONCE_MISMATCH"
  | "UNSUPPORTED_VERSION"
  | "INVALID_RADIUS"
  | "DELEGATION_SIGNATURE_INVALID"
  | "RESPONSE_SIGNATURE_INVALID"
  | "OUTSIDE_DELEGATION_WINDOW"
  | "MERKLE_PROOF_INVALID"
  | "RESPONSE_LARGER_THAN_REQUEST"
  | "TIME_OUT_OF_RANGE";

export type VerifiedRoughtimeResponse = {
  ok: true;
  /** Seconds since the Unix epoch (RFC 10049 §4.1.4). */
  midpointSeconds: number;
  radiusSeconds: number;
  /**
   * The open interval (MIDP-RADI, MIDP+RADI) in ms, reported inclusively — wider than the
   * guarantee, never narrower.
   */
  earliestMs: number;
  latestMs: number;
  /** H(response packet): identity of this exact signed response. */
  responseDigest: Buffer;
};

export type RoughtimeVerification =
  | VerifiedRoughtimeResponse
  | { ok: false; reason: RoughtimeRejection };

const reject = (reason: RoughtimeRejection): RoughtimeVerification => ({ ok: false, reason });

const ed25519Key = (raw: Buffer) =>
  createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });

const validSignature = (context: Buffer, value: Buffer, signature: Buffer, key: Buffer) =>
  signature.length === 64 &&
  key.length === 32 &&
  verifySignature(null, Buffer.concat([context, value]), ed25519Key(key), signature);

/** RFC 10049 §5.3.1 root value validity check. */
export const merkleRootMatches = (
  requestPacket: Buffer,
  path: Buffer,
  index: number,
  root: Buffer,
): boolean => {
  if (path.length % 32 !== 0 || path.length / 32 > MAX_PATH_NODES || root.length !== 32)
    return false;
  let h = roughtimeHash(Buffer.from([0x00]), requestPacket);
  let remaining = index;
  for (let offset = 0; offset < path.length; offset += 32) {
    const node = path.subarray(offset, offset + 32);
    h =
      remaining % 2 === 0
        ? roughtimeHash(Buffer.from([0x01]), h, node)
        : roughtimeHash(Buffer.from([0x01]), node, h);
    remaining = Math.floor(remaining / 2);
  }
  return remaining === 0 && h.equals(root);
};

/**
 * Verifies one response against the exact request packet that was sent and the pinned
 * long-term key of the server that was asked.
 */
export const verifyRoughtimeResponse = (input: {
  requestPacket: Buffer;
  responsePacket: Buffer;
  longTermPublicKey: Buffer;
}): RoughtimeVerification => {
  try {
    if (input.responsePacket.length > input.requestPacket.length)
      return reject("RESPONSE_LARGER_THAN_REQUEST");
    const request = decodeMessage(decodePacket(input.requestPacket));
    const response = decodeMessage(decodePacket(input.responsePacket));

    if (readUint32(response.get("TYPE"), "TYPE") !== 1) return reject("NOT_A_RESPONSE");
    const nonce = required(request, "NONC");
    if (!required(response, "NONC").equals(nonce)) return reject("NONCE_MISMATCH");

    const srepBytes = required(response, "SREP");
    const srep = decodeMessage(srepBytes);
    if (readUint32(srep.get("VER"), "VER") !== ROUGHTIME_VERSION_1)
      return reject("UNSUPPORTED_VERSION");
    const vers = required(srep, "VERS");
    if (vers.length % 4 !== 0 || vers.length === 0 || vers.length > 128) return reject("MALFORMED");
    const supported = Array.from({ length: vers.length / 4 }, (_, i) => vers.readUInt32LE(4 * i));
    if (!supported.includes(ROUGHTIME_VERSION_1)) return reject("UNSUPPORTED_VERSION");

    const radius = readUint32(srep.get("RADI"), "RADI");
    if (radius === 0) return reject("INVALID_RADIUS");
    const midpoint = readUint64(srep.get("MIDP"), "MIDP");
    const root = required(srep, "ROOT");

    const cert = decodeMessage(required(response, "CERT"));
    const deleBytes = required(cert, "DELE");
    if (
      !validSignature(DELEGATION_CONTEXT, deleBytes, required(cert, "SIG"), input.longTermPublicKey)
    )
      return reject("DELEGATION_SIGNATURE_INVALID");
    const dele = decodeMessage(deleBytes);
    const delegatedKey = required(dele, "PUBK");
    const mint = readUint64(dele.get("MINT"), "MINT");
    const maxt = readUint64(dele.get("MAXT"), "MAXT");
    if (!validSignature(RESPONSE_CONTEXT, srepBytes, required(response, "SIG"), delegatedKey))
      return reject("RESPONSE_SIGNATURE_INVALID");
    if (midpoint < mint || midpoint > maxt) return reject("OUTSIDE_DELEGATION_WINDOW");

    const index = readUint32(response.get("INDX"), "INDX");
    if (!merkleRootMatches(input.requestPacket, required(response, "PATH"), index, root))
      return reject("MERKLE_PROOF_INVALID");

    const radiusBig = BigInt(radius);
    if (midpoint < radiusBig) return reject("TIME_OUT_OF_RANGE");
    const earliestMs = (midpoint - radiusBig) * 1000n;
    const latestMs = (midpoint + radiusBig) * 1000n;
    if (latestMs > BigInt(Number.MAX_SAFE_INTEGER)) return reject("TIME_OUT_OF_RANGE");
    return {
      ok: true,
      midpointSeconds: Number(midpoint),
      radiusSeconds: radius,
      earliestMs: Number(earliestMs),
      latestMs: Number(latestMs),
      responseDigest: roughtimeHash(input.responsePacket),
    };
  } catch {
    // RoughtimeFormatError, or invalid key material raised by node:crypto: never valid.
    return reject("MALFORMED");
  }
};
