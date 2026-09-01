import { createHash } from "node:crypto";

import { jwtVerify, SignJWT } from "jose";

import { env } from "../../config/env.js";
import { MarketingError } from "./marketing.errors.js";

/**
 * Marketing Email Stage M2 — the unsubscribe token.
 *
 * A stateless signed JWT (HS256 via `jose`), exactly mirroring the existing signed-token
 * precedent in `integration.state.ts` (OAuth `state`) and `token.service.ts` (access token).
 * Chosen over a `MarketingUnsubscribeToken` collection because:
 *
 *  - it is purpose-bound and tamper-evident on its own — no DB row to look up, so no lookup key
 *    that could enable account enumeration;
 *  - the token confers the smallest possible capability (flip ONE boolean to `false`, one-way),
 *    so it does not warrant its own persistence, rotation, or revocation machinery;
 *  - unsubscribe links must keep working for the life of any marketing email already delivered,
 *    so there is intentionally NO `exp` claim — a stored-token TTL would be the wrong model.
 *
 * The signing key is derived from `JWT_ACCESS_TOKEN_SECRET` with a hashed domain-separation
 * prefix, so this key is unrelated to the raw access-token key and to the Google-state key: an
 * access token, an OAuth-state token, or a token minted for any other purpose cannot verify
 * here, and this token cannot be replayed against `jwtVerify` elsewhere. The `purpose` claim is
 * additionally asserted on verify as defence in depth.
 */

const TOKEN_PURPOSE = "marketing-unsubscribe" as const;

const signingKey = (): Uint8Array =>
  createHash("sha256")
    .update(`marketing-unsubscribe-token:${env.JWT_ACCESS_TOKEN_SECRET}`)
    .digest();

export type MarketingUnsubscribeClaims = {
  /** The linked account's user id. No email or other PII is ever placed in the token. */
  userId: string;
};

export const signMarketingUnsubscribeToken = (userId: string): Promise<string> =>
  new SignJWT({ purpose: TOKEN_PURPOSE })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .sign(signingKey());

export const verifyMarketingUnsubscribeToken = async (
  token: string,
): Promise<MarketingUnsubscribeClaims> => {
  try {
    const result = await jwtVerify(token, signingKey());
    const userId = result.payload.sub;

    if (typeof userId !== "string" || userId.length === 0) {
      throw new Error("missing subject");
    }
    if (result.payload["purpose"] !== TOKEN_PURPOSE) {
      throw new Error("wrong purpose");
    }

    return { userId };
  } catch {
    throw new MarketingError("MARKETING_UNSUBSCRIBE_LINK_INVALID", 400);
  }
};
