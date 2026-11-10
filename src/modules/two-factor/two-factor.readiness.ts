import { env } from "../../config/env.js";
import { AuthError } from "../auth/auth.errors.js";
import { TwoFactorChallengeModel } from "./two-factor.model.js";

/** Enrollment is an operator-controlled rollout; existing enabled accounts must keep enforcing
 * their factors when rollout is stopped. These checks are read-only and never provision indexes,
 * probe with a write, or infer that a hosting plan/fleet has been verified from a URI. */
export const assertTwoFactorEnrollmentReady = async (): Promise<void> => {
  const unavailable = () => new AuthError("TWO_FACTOR_ENROLLMENT_UNAVAILABLE", 503);
  if (
    !env.TWO_FACTOR_ENROLLMENT_ENABLED ||
    !env.TOTP_ENCRYPTION_KEY_V1 ||
    (env.NODE_ENV === "production" &&
      (!env.AUTH_COOKIE_SECURE || !env.FRONTEND_BASE_URL.startsWith("https://")))
  ) {
    throw unavailable();
  }

  try {
    const db = TwoFactorChallengeModel.db.db;
    if (!db) throw unavailable();
    const topology = await db.command({ hello: 1, maxTimeMS: 3_000 }, { timeoutMS: 3_000 });
    const replicaSet = typeof topology["setName"] === "string" && topology["setName"].length > 0;
    const mongos = topology["msg"] === "isdbgrid";
    if (
      (!replicaSet && !mongos) ||
      typeof topology["logicalSessionTimeoutMinutes"] !== "number" ||
      !Number.isFinite(topology["logicalSessionTimeoutMinutes"]) ||
      topology["logicalSessionTimeoutMinutes"] <= 0 ||
      typeof topology["maxWireVersion"] !== "number" ||
      !Number.isInteger(topology["maxWireVersion"]) ||
      topology["maxWireVersion"] < (mongos ? 8 : 7)
    ) {
      throw unavailable();
    }

    const indexes = await TwoFactorChallengeModel.collection
      .listIndexes({ maxTimeMS: 3_000 })
      .toArray();
    const singleKey = (key: object, field: string) =>
      Object.keys(key).length === 1 && (key as Record<string, unknown>)[field] === 1;
    const fullIndex = (index: (typeof indexes)[number]) =>
      !index.partialFilterExpression && !index.sparse;
    const unique = indexes.some(
      (index) => singleKey(index.key, "tokenHash") && index.unique === true && fullIndex(index),
    );
    const ttl = indexes.some(
      (index) =>
        singleKey(index.key, "expiresAt") && index.expireAfterSeconds === 0 && fullIndex(index),
    );
    if (!unique || !ttl) throw unavailable();
  } catch {
    // No hostnames, index metadata or driver errors are sent to the Client or logged with keys.
    throw unavailable();
  }
};
