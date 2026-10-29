/**
 * P1B — public Roughtime servers for MEASUREMENT ONLY on an approved trusted host.
 *
 * NOT a trust registry. `productionApproved` is the literal `false` for every entry and the
 * P1A verifier's approved-authority registry stays empty. Facts below are from published
 * documentation on 27 October 2026 and were NOT confirmed by any network query:
 *  - keys and addresses: cloudflare/roughtime `ecosystem.json`;
 *  - versions/terms: cloudflare/roughtime `ecosystem.md`, https://time.txryan.com/ and the
 *    int08h/roughenough README.
 * The port-5319 endpoints are assumed to use the same long-term key as the listed ones; the
 * measurement verifies that (a wrong key fails signature verification).
 */

export type RoughtimeCandidate = {
  serverId: string;
  operatorId: string;
  host: string;
  port: number;
  /** Base64 Ed25519 long-term key as published. */
  publicKeyBase64: string;
  /** What the operator documents about RFC 10049 version 1. */
  rfc10049Version1: "DOCUMENTED" | "NOT_DOCUMENTED";
  productionApproved: false;
  note: string;
};

export const ROUGHTIME_MEASUREMENT_CANDIDATES: readonly RoughtimeCandidate[] = Object.freeze([
  {
    serverId: "txryan-5319",
    operatorId: "txryan.com",
    host: "time.txryan.com",
    port: 5319,
    publicKeyBase64: "iBVjxg/1j7y1+kQUTBYdTabxCppesU/07D4PMDJk2WA=",
    rfc10049Version1: "DOCUMENTED",
    productionApproved: false,
    note: "Individual operator. 'Contact Tanner … before using it for high-volume infrastructure.' No uptime or accuracy guarantees.",
  },
  {
    serverId: "int08h-5319",
    operatorId: "int08h.com",
    host: "roughtime.int08h.com",
    port: 5319,
    publicKeyBase64: "AW5uAoTSTDfG5NfY1bTh08GUnOqlRb+HVhbJ3ODJvsE=",
    rfc10049Version1: "DOCUMENTED",
    productionApproved: false,
    note: "roughenough README: server answers only RFC 10049 version 1. No published terms or rate limits.",
  },
  {
    serverId: "roughtime-se-2002",
    operatorId: "roughtime.se",
    host: "roughtime.se",
    port: 2002,
    publicKeyBase64: "S3AzfZJ5CjSdkJ21ZJGbxqdYP/SoE8fXKY0+aicsehI=",
    rfc10049Version1: "NOT_DOCUMENTED",
    productionApproved: false,
    note: "Aims at the latest IETF draft; 'no availability is guaranteed'. Website unreachable when checked.",
  },
  {
    serverId: "cloudflare-2003",
    operatorId: "cloudflare.com",
    host: "roughtime.cloudflare.com",
    port: 2003,
    publicKeyBase64: "0GD7c3yP8xEc4Zl2zeuN2SlLvDVVocjsPSL8/Rl/7zg=",
    rfc10049Version1: "NOT_DOCUMENTED",
    productionApproved: false,
    note: "Documented as Google-Roughtime + IETF draft08 only; beta, root key subject to change.",
  },
]);
