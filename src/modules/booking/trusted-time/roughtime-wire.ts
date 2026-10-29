import { createHash } from "node:crypto";

/**
 * P1B — RFC 10049 (Roughtime, Experimental) wire format, version 1 only. Pure codec: no
 * network, no clock, no Bookly data. Draft versions (e.g. 0x8000000c, draft-08) are NOT
 * supported; their wire rules are not in RFC 10049.
 *
 * References: RFC 10049 §4 (message), §4.2 (header), §5 (packet), §5.1 (request),
 * §5.3 (Merkle tree).
 */

export const ROUGHTIME_VERSION_1 = 1;
/** "ROUGHTIM" as the little-endian uint64 0x4d49544847554f52 (RFC 10049 §5). */
export const ROUGHTIME_PACKET_MAGIC = Buffer.from("ROUGHTIM", "ascii");
/** RFC 10049 §5.1: the request message SHOULD be at least 1024 bytes over UDP. */
export const ROUGHTIME_MIN_REQUEST_MESSAGE_BYTES = 1024;

export class RoughtimeFormatError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RoughtimeFormatError";
  }
}

const fail = (message: string): never => {
  throw new RoughtimeFormatError(message);
};

/** H(x): first 32 bytes of SHA-512 (RFC 10049 §5.1.4, §5.3.1). */
export const roughtimeHash = (...parts: Buffer[]): Buffer =>
  createHash("sha512").update(Buffer.concat(parts)).digest().subarray(0, 32);

/** Tag string → its 4 octets (1–4 capital letters, zero-padded). */
export const tagBytes = (tag: string): Buffer => {
  if (!/^[A-Z]{1,4}$/.test(tag)) fail(`Invalid tag ${JSON.stringify(tag)}`);
  const bytes = Buffer.alloc(4);
  bytes.write(tag, "ascii");
  return bytes;
};

const tagValue = (bytes: Buffer): number => bytes.readUInt32LE(0);

const tagName = (bytes: Buffer): string => {
  let end = 4;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  const name = bytes.subarray(0, end).toString("latin1");
  // 1–4 capital ASCII letters followed only by zero padding (RFC 10049 §4.1.3).
  if (!/^[A-Z]{1,4}$/.test(name)) fail("Malformed tag");
  return name;
};

export type RoughtimeMessage = ReadonlyMap<string, Buffer>;

/** Encodes (tag, value) pairs. Values other than the last must be multiples of 4 bytes. */
export const encodeMessage = (pairs: ReadonlyArray<readonly [string, Buffer]>): Buffer => {
  const sorted = pairs
    .map(([tag, value]) => ({ tag, bytes: tagBytes(tag), value }))
    .sort((a, b) => tagValue(a.bytes) - tagValue(b.bytes));
  for (let i = 1; i < sorted.length; i += 1)
    if (tagValue(sorted[i - 1]?.bytes as Buffer) === tagValue(sorted[i]?.bytes as Buffer))
      fail("Duplicate tag");
  const n = sorted.length;
  const header = Buffer.alloc(n === 0 ? 4 : 8 * n);
  header.writeUInt32LE(n, 0);
  let offset = 0;
  sorted.forEach((entry, i) => {
    if (i > 0) header.writeUInt32LE(offset, 4 * i);
    if (i < n - 1 && entry.value.length % 4 !== 0) fail("Value length must be a multiple of 4");
    offset += entry.value.length;
  });
  sorted.forEach((entry, i) => {
    entry.bytes.copy(header, 4 + 4 * (n - 1) + 4 * i);
  });
  return Buffer.concat([header, ...sorted.map((entry) => entry.value)]);
};

/** Strict decoder (RFC 10049 §4.2): sorted unique tags, aligned non-decreasing offsets. */
export const decodeMessage = (message: Buffer): RoughtimeMessage => {
  if (message.length < 4) fail("Truncated message");
  const n = message.readUInt32LE(0);
  if (n === 0) return new Map();
  // Bound N before allocating: each pair needs at least 8 header bytes.
  if (n > message.length / 8) fail("Header longer than message");
  const headerBytes = 8 * n;
  const values = message.subarray(headerBytes);
  const offsets = [0];
  for (let i = 1; i < n; i += 1) offsets.push(message.readUInt32LE(4 * i));
  const tags = Array.from({ length: n }, (_, i) =>
    message.subarray(4 + 4 * (n - 1) + 4 * i, 8 + 4 * (n - 1) + 4 * i),
  );
  const result = new Map<string, Buffer>();
  for (let i = 0; i < n; i += 1) {
    const start = offsets[i] as number;
    const end = i + 1 < n ? (offsets[i + 1] as number) : values.length;
    if (start % 4 !== 0) fail("Unaligned offset");
    if (start > end || end > values.length) fail("Offset out of range");
    if (i > 0 && tagValue(tags[i - 1] as Buffer) >= tagValue(tags[i] as Buffer))
      fail("Tags not strictly ascending");
    result.set(tagName(tags[i] as Buffer), values.subarray(start, end));
  }
  return result;
};

export const encodePacket = (message: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(message.length, 0);
  return Buffer.concat([ROUGHTIME_PACKET_MAGIC, length, message]);
};

export const decodePacket = (packet: Buffer): Buffer => {
  if (packet.length < 12) fail("Truncated packet");
  if (!packet.subarray(0, 8).equals(ROUGHTIME_PACKET_MAGIC)) fail("Bad packet magic");
  const length = packet.readUInt32LE(8);
  if (packet.length !== 12 + length) fail("Packet length mismatch");
  return packet.subarray(12);
};

export const uint32 = (value: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value, 0);
  return b;
};

export const uint64 = (value: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(value, 0);
  return b;
};

export const readUint32 = (value: Buffer | undefined, what: string): number => {
  if (!value || value.length !== 4) return fail(`${what} must be a uint32`);
  return value.readUInt32LE(0);
};

export const readUint64 = (value: Buffer | undefined, what: string): bigint => {
  if (!value || value.length !== 8) return fail(`${what} must be a uint64`);
  return value.readBigUInt64LE(0);
};

export const required = (message: RoughtimeMessage, tag: string): Buffer => {
  const value = message.get(tag);
  if (value === undefined) return fail(`Missing ${tag}`);
  return value;
};

/** SRV value: H(0xff || long-term public key) (RFC 10049 §5.1.4). */
export const srvValue = (longTermPublicKey: Buffer): Buffer =>
  roughtimeHash(Buffer.from([0xff]), longTermPublicKey);

/**
 * Builds a version-1 request packet (VER, NONC, TYPE=0, SRV, ZZZZ padding to the minimum
 * size). The nonce is the only variable content; it must never carry readable Bookly data.
 */
export const buildRequestPacket = (nonce: Buffer, longTermPublicKey: Buffer): Buffer => {
  if (nonce.length !== 32) fail("NONC must be 32 bytes");
  if (longTermPublicKey.length !== 32) fail("Ed25519 public key must be 32 bytes");
  const fixed: Array<[string, Buffer]> = [
    ["VER", uint32(ROUGHTIME_VERSION_1)],
    ["NONC", nonce],
    ["TYPE", uint32(0)],
    ["SRV", srvValue(longTermPublicKey)],
  ];
  const unpadded = encodeMessage([...fixed, ["ZZZZ", Buffer.alloc(0)]]).length;
  const padding = Math.max(0, ROUGHTIME_MIN_REQUEST_MESSAGE_BYTES - unpadded);
  return encodePacket(encodeMessage([...fixed, ["ZZZZ", Buffer.alloc(padding)]]));
};
