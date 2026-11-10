import { isDeepStrictEqual } from "node:util";

/**
 * P2.2.9.1 — read-only activation readiness for the reliable ordinary Google Calendar path.
 *
 * Nothing here enables anything: both rollout authorities stay default-denied until a reviewed
 * activation release replaces `ordinary-calendar-journal-authority.ts`. This module only answers
 * "could it be activated safely right now?" for an operator, and lets the worker launcher fail
 * closed. It never creates or repairs indexes, never writes, never calls Google, and reports
 * no hostnames, credentials, connection strings or provider payloads.
 */

/** The exact shapes the journal model declares and the consumer's queries rely on. */
export const ORDINARY_CALENDAR_INDEX_SPECS = [
  { name: "bookingId_1", key: { bookingId: 1 }, unique: true },
  {
    name: "mode_1_state_1_nextAttemptAt_1",
    key: { mode: 1, state: 1, nextAttemptAt: 1 },
    unique: false,
  },
] as const;

export type OrdinaryCalendarIndexDescription = {
  name?: string;
  key?: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: unknown;
  collation?: unknown;
  expireAfterSeconds?: unknown;
  hidden?: boolean;
};

export type OrdinaryCalendarIndexDiagnosis = {
  ready: boolean;
  /** Required specs with no index on that key at all → safe to create. */
  missing: string[];
  /** An index exists on the required key but with incompatible options → must be reviewed and
   * replaced by an operator; `createIndex` would fail (IndexKeySpecsConflict) or be unsafe. */
  conflicting: Array<{ name: string; problem: string }>;
};

/**
 * A required index only counts when it covers every document exactly as the consumer assumes:
 * same key (and key order), same uniqueness, and no partial filter, sparse, collation, TTL or
 * hidden option that would let duplicates through or skip rows. Extra unrelated indexes are fine.
 */
export function diagnoseOrdinaryCalendarIndexes(
  indexes: readonly OrdinaryCalendarIndexDescription[],
): OrdinaryCalendarIndexDiagnosis {
  const missing: string[] = [];
  const conflicting: OrdinaryCalendarIndexDiagnosis["conflicting"] = [];
  for (const spec of ORDINARY_CALENDAR_INDEX_SPECS) {
    // Key ORDER matters for a compound index; plain object equality would ignore it.
    const sameKey = indexes.filter((index) =>
      isDeepStrictEqual(Object.entries(index.key ?? {}), Object.entries(spec.key)),
    );
    if (sameKey.length === 0) {
      missing.push(spec.name);
      continue;
    }
    const problems = (index: OrdinaryCalendarIndexDescription) => {
      const found: string[] = [];
      if (Boolean(index.unique) !== spec.unique)
        found.push(spec.unique ? "not unique" : "unexpectedly unique");
      if (index.partialFilterExpression) found.push("partial filter");
      if (index.sparse) found.push("sparse");
      if (index.collation) found.push("collation");
      if (index.expireAfterSeconds !== undefined) found.push("TTL");
      if (index.hidden) found.push("hidden");
      return found;
    };
    if (sameKey.some((index) => problems(index).length === 0)) continue;
    conflicting.push({
      name: sameKey[0]?.name ?? spec.name,
      problem: problems(sameKey[0] ?? {}).join(", "),
    });
  }
  return { ready: missing.length === 0 && conflicting.length === 0, missing, conflicting };
}

/** Transactions need a replica set or a sharded cluster (Atlas Free/M0 is a replica set). */
export function isTransactionCapableTopology(hello: Record<string, unknown>): boolean {
  const replicaSet = typeof hello["setName"] === "string" && hello["setName"].length > 0;
  const mongos = hello["msg"] === "isdbgrid";
  const session = hello["logicalSessionTimeoutMinutes"];
  const wire = hello["maxWireVersion"];
  return (
    (replicaSet || mongos) &&
    typeof session === "number" &&
    Number.isFinite(session) &&
    session > 0 &&
    typeof wire === "number" &&
    Number.isInteger(wire) &&
    wire >= (mongos ? 8 : 7)
  );
}

export type OrdinaryCalendarReadinessCheck = {
  name:
    | "DELIVERY_AUTHORITY"
    | "CREATION_AUTHORITY"
    | "JOURNAL_INDEXES"
    | "TRANSACTION_CAPABLE_DATABASE"
    | "GOOGLE_OAUTH_CONFIGURED"
    | "TOKEN_ENCRYPTION_KEY_CONFIGURED";
  ok: boolean;
  detail: string;
};

/** Prerequisites code cannot observe; an operator must record evidence for each before the
 * authority module is replaced. Listed so the report is never mistaken for a full approval. */
export const ORDINARY_CALENDAR_MANUAL_GATES = [
  "GOOGLE_SANDBOX_QUALIFICATION_RECORDED",
  "WORKER_RUNTIME_PROVISIONED_ON_EXISTING_FREE_HOST",
  "OWNER_RATIFIED_D1_D2_D3_AND_RETRY_POLICY",
  "ALERT_ROUTING_REVIEWED",
  "ALL_API_INSTANCES_ON_COMPATIBLE_RELEASE",
  "GOOGLE_CALENDAR_API_QUOTA_REVIEWED",
] as const;

export type OrdinaryCalendarActivationProbes = {
  deliveryAuthority: () => Promise<void>;
  creationAuthority: () => Promise<boolean>;
  listIndexes: () => Promise<OrdinaryCalendarIndexDescription[]>;
  hello: () => Promise<Record<string, unknown>>;
  googleOAuthConfigured: () => boolean;
  tokenEncryptionKeyConfigured: () => boolean;
};

export type OrdinaryCalendarActivationReport = {
  /** True only when every automatic check passes. Manual gates still apply. */
  automaticChecksPassed: boolean;
  /** Infrastructure prerequisites only (indexes, transactions, config) — the authorities are
   * expected to be denied before activation; this says whether the activation release may proceed. */
  infrastructureReady: boolean;
  checks: OrdinaryCalendarReadinessCheck[];
  indexes: OrdinaryCalendarIndexDiagnosis | null;
  manualGates: readonly string[];
};

/** Every probe failure is a failed check (fail closed); nothing is thrown or retried. */
export async function evaluateOrdinaryCalendarActivationReadiness(
  probes: OrdinaryCalendarActivationProbes,
): Promise<OrdinaryCalendarActivationReport> {
  const checks: OrdinaryCalendarReadinessCheck[] = [];
  const settle = async <T>(probe: () => Promise<T>): Promise<{ value?: T; failed: boolean }> => {
    try {
      return { value: await probe(), failed: false };
    } catch {
      return { failed: true };
    }
  };

  const delivery = await settle(probes.deliveryAuthority);
  checks.push({
    name: "DELIVERY_AUTHORITY",
    ok: !delivery.failed,
    detail: delivery.failed ? "Denied (default until a reviewed activation release)" : "Granted",
  });
  const creation = await settle(probes.creationAuthority);
  checks.push({
    name: "CREATION_AUTHORITY",
    ok: creation.value === true,
    detail:
      creation.value === true ? "Granted" : "Denied (default until a reviewed activation release)",
  });

  const listed = await settle(probes.listIndexes);
  const indexes = listed.failed ? null : diagnoseOrdinaryCalendarIndexes(listed.value ?? []);
  checks.push({
    name: "JOURNAL_INDEXES",
    ok: indexes?.ready === true,
    detail: !indexes
      ? "Could not read index metadata (collection missing or not reachable)"
      : indexes.ready
        ? "Both required indexes present with exact options"
        : [
            indexes.missing.length ? `missing: ${indexes.missing.join(", ")}` : "",
            indexes.conflicting.length
              ? `conflicting: ${indexes.conflicting.map((c) => `${c.name} (${c.problem})`).join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join("; "),
  });

  const hello = await settle(probes.hello);
  const transactional = !hello.failed && isTransactionCapableTopology(hello.value ?? {});
  checks.push({
    name: "TRANSACTION_CAPABLE_DATABASE",
    ok: transactional,
    detail: transactional
      ? "Replica set / sharded cluster with sessions"
      : "Not a transaction-capable topology (or unreachable)",
  });

  const oauth = (() => {
    try {
      return probes.googleOAuthConfigured();
    } catch {
      return false;
    }
  })();
  checks.push({
    name: "GOOGLE_OAUTH_CONFIGURED",
    ok: oauth,
    detail: oauth
      ? "Client id, secret and redirect URI present"
      : "Google OAuth settings incomplete",
  });
  const key = (() => {
    try {
      return probes.tokenEncryptionKeyConfigured();
    } catch {
      return false;
    }
  })();
  checks.push({
    name: "TOKEN_ENCRYPTION_KEY_CONFIGURED",
    ok: key,
    detail: key ? "Token encryption key present" : "Token encryption key missing",
  });

  const infrastructure = checks.filter(
    (check) => check.name !== "DELIVERY_AUTHORITY" && check.name !== "CREATION_AUTHORITY",
  );
  return {
    automaticChecksPassed: checks.every((check) => check.ok),
    infrastructureReady: infrastructure.every((check) => check.ok),
    checks,
    indexes,
    manualGates: ORDINARY_CALENDAR_MANUAL_GATES,
  };
}

/**
 * P2.2.9.2 — process exit code for a deliberate gate refusal (EX_CONFIG). Process managers must
 * NOT restart on it (PM2 `stop_exit_codes`); only genuine failures (code 1) are restartable.
 */
export const ORDINARY_CALENDAR_WORKER_REFUSED_EXIT_CODE = 78;

/** Classifies why the worker launcher stopped: a gate refusal (do not restart) or a failure. */
export function ordinaryCalendarWorkerStop(error: unknown): {
  exitCode: number;
  refused: boolean;
  reason: "DELIVERY_AUTHORITY_DENIED" | "JOURNAL_NOT_PROVISIONED" | "FAILED";
} {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : "";
  if (
    code === "ORDINARY_CALENDAR_DELIVERY_UNAVAILABLE" ||
    message === "ORDINARY_CALENDAR_DELIVERY_UNAVAILABLE"
  )
    return {
      exitCode: ORDINARY_CALENDAR_WORKER_REFUSED_EXIT_CODE,
      refused: true,
      reason: "DELIVERY_AUTHORITY_DENIED",
    };
  if (message === "ORDINARY_CALENDAR_JOURNAL_NOT_PROVISIONED")
    return {
      exitCode: ORDINARY_CALENDAR_WORKER_REFUSED_EXIT_CODE,
      refused: true,
      reason: "JOURNAL_NOT_PROVISIONED",
    };
  return { exitCode: 1, refused: false, reason: "FAILED" };
}

/** Fail-closed guard for the worker launcher: the journal must be provisioned exactly. */
export async function assertOrdinaryCalendarJournalProvisioned(
  listIndexes: () => Promise<OrdinaryCalendarIndexDescription[]>,
): Promise<void> {
  let diagnosis: OrdinaryCalendarIndexDiagnosis;
  try {
    diagnosis = diagnoseOrdinaryCalendarIndexes(await listIndexes());
  } catch {
    throw new Error("ORDINARY_CALENDAR_JOURNAL_NOT_PROVISIONED");
  }
  if (!diagnosis.ready) throw new Error("ORDINARY_CALENDAR_JOURNAL_NOT_PROVISIONED");
}
