import argon2 from "argon2";

import { env } from "../../config/env.js";

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /** `hash` is nullable so callers need no guard for a passwordless (Google-only) account: an
   * absent hash can never match, so this resolves to `false` — the same outcome a wrong password
   * produces. Every pre-Phase-2A account has a hash, so that path is currently unreachable. */
  verify(hash: string | undefined, password: string): Promise<boolean>;
}

export class Argon2PasswordHasher implements PasswordHasher {
  public async hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: env.ARGON2_MEMORY_COST,
      timeCost: env.ARGON2_TIME_COST,
      parallelism: env.ARGON2_PARALLELISM,
    });
  }

  public async verify(hash: string | undefined, password: string): Promise<boolean> {
    if (!hash) {
      return false;
    }

    return argon2.verify(hash, password);
  }
}
