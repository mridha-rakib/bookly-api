import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { env } from "../../config/env.js";
import { IntegrationError } from "./integration.errors.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function requireKey(): Buffer {
  if (!env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY) {
    throw new IntegrationError("GOOGLE_CALENDAR_NOT_CONFIGURED", 503);
  }

  return Buffer.from(env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY, "hex");
}

/** AES-256-GCM encrypt, output as `${iv}:${authTag}:${ciphertext}` hex-joined. */
export function encryptSecret(plaintext: string): string {
  const key = requireKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(payload: string): string {
  const key = requireKey();
  const [ivHex, authTagHex, ciphertextHex] = payload.split(":");

  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new IntegrationError("GOOGLE_CALENDAR_OAUTH_FAILED", 500);
  }

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}
