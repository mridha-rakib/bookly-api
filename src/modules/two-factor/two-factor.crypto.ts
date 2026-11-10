import { createHash, randomBytes } from "node:crypto";
import { Secret, TOTP } from "otpauth";

import {
  decryptSecret,
  type EncryptedSecret,
  encryptSecret,
} from "../../common/crypto/aes-256-gcm-secret.js";
import { env } from "../../config/env.js";
import { AuthError } from "../auth/auth.errors.js";

const key = (): string => {
  if (!env.TOTP_ENCRYPTION_KEY_V1) throw new AuthError("TWO_FACTOR_UNAVAILABLE", 503);
  return env.TOTP_ENCRYPTION_KEY_V1;
};
export const sealTotp = (secret: string, userId: string): EncryptedSecret =>
  encryptSecret(secret, key(), `bookly:totp:v1:${userId}`);
export const openTotp = (secret: EncryptedSecret, userId: string): string => {
  try {
    return decryptSecret(secret, key(), `bookly:totp:v1:${userId}`);
  } catch {
    throw new AuthError("TWO_FACTOR_UNAVAILABLE", 503);
  }
};
export const newTotp = (email: string) =>
  new TOTP({
    issuer: "Bookly",
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: new Secret({ size: 20 }),
  });
export const verifyTotpStep = (secret: string, code: string, now = Date.now()): number | null => {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = new TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).validate({ token: code, timestamp: now, window: 1 });
  return delta === null ? null : Math.floor(now / 30_000) + delta;
};
export const opaqueToken = () => randomBytes(32).toString("hex");
export const hashCredential = (value: string) => createHash("sha256").update(value).digest("hex");
export const makeRecoveryCodes = () =>
  Array.from({ length: 10 }, () => randomBytes(16).toString("hex"));
