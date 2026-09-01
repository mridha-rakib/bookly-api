import { createHash } from "node:crypto";

import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { env } from "../../src/config/env.js";
import { MarketingError } from "../../src/modules/marketing/marketing.errors.js";
import {
  signMarketingUnsubscribeToken,
  verifyMarketingUnsubscribeToken,
} from "../../src/modules/marketing/marketing-unsubscribe.token.js";

const decodeClaims = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));

const marketingKey = (): Uint8Array =>
  createHash("sha256")
    .update(`marketing-unsubscribe-token:${env.JWT_ACCESS_TOKEN_SECRET}`)
    .digest();

describe("marketing unsubscribe token", () => {
  it("round-trips the userId", async () => {
    const token = await signMarketingUnsubscribeToken("user-123");
    await expect(verifyMarketingUnsubscribeToken(token)).resolves.toEqual({ userId: "user-123" });
  });

  it("carries no email/PII and no expiry claim, only sub + purpose + iat", async () => {
    const token = await signMarketingUnsubscribeToken("64b7f0c2e1a2b3c4d5e6f7a8");
    const claims = decodeClaims(token);

    expect(claims["sub"]).toBe("64b7f0c2e1a2b3c4d5e6f7a8");
    expect(claims["purpose"]).toBe("marketing-unsubscribe");
    expect(claims["exp"]).toBeUndefined();
    expect(Object.keys(claims).sort()).toEqual(["iat", "purpose", "sub"]);
    expect(JSON.stringify(claims)).not.toMatch(/@/);
  });

  it("rejects a tampered token generically", async () => {
    const token = await signMarketingUnsubscribeToken("user-123");
    const tampered = `${token.slice(0, -3)}xyz`;
    await expect(verifyMarketingUnsubscribeToken(tampered)).rejects.toBeInstanceOf(MarketingError);
  });

  it("rejects garbage and empty input generically", async () => {
    await expect(verifyMarketingUnsubscribeToken("not-a-jwt")).rejects.toBeInstanceOf(
      MarketingError,
    );
    await expect(verifyMarketingUnsubscribeToken("")).rejects.toBeInstanceOf(MarketingError);
  });

  it("rejects a correctly-signed token minted for a different purpose", async () => {
    const wrongPurpose = await new SignJWT({ purpose: "password-reset" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-123")
      .setIssuedAt()
      .sign(marketingKey());

    await expect(verifyMarketingUnsubscribeToken(wrongPurpose)).rejects.toBeInstanceOf(
      MarketingError,
    );
  });

  it("rejects a token signed with a different key (e.g. the raw access-token secret)", async () => {
    const foreign = await new SignJWT({ purpose: "marketing-unsubscribe" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-123")
      .setIssuedAt()
      .sign(new TextEncoder().encode(env.JWT_ACCESS_TOKEN_SECRET));

    await expect(verifyMarketingUnsubscribeToken(foreign)).rejects.toBeInstanceOf(MarketingError);
  });
});
