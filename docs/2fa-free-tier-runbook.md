# Professional 2FA: existing free-infrastructure runbook

Status: prepared for operator review on 7 November 2026. Nothing in this document has been executed against a deployment. No subscription, trial, hosting move, production key, index or database operation is authorized by this document alone.

## Cost boundary and verified implementation

Professional 2FA uses the existing API process, MongoDB connection, User and Session records, one pre-authentication collection, OTPAuth, node-qrcode and local AES-256-GCM. It requires no paid MFA, SMS/email delivery, external QR API, KMS, Search index, Trigger or Function. Existing registration, messaging, storage and provider configuration elsewhere in Bookly is outside this change; this document does not certify those services as free or alter their billing. In particular, the current production configuration requires Twilio phone-verification credentials and rejects the dummy phone provider, and defaults email delivery to SendGrid. Those are pre-existing bootstrap/provider dependencies, not TOTP calls. Whether their existing accounts permit continued zero-cost operation is unverified; do not purchase service, use dummy verification in production, or weaken bootstrap validation to work around this. If the existing deployment cannot satisfy its unrelated provider configuration at zero additional cost, record that deployment blocker and keep enrollment off.

Atlas Free/M0 is a three-node replica set. Ordinary replica-set transactions are supported by MongoDB; standalone MongoDB is not a substitute. This is a compatibility conclusion from the vendor's documented capabilities and the application's code, not a successful transaction test against the Owner's cluster. Sources: [Atlas Free limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/), [transaction requirements](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/).

The repository supplies a Node 24 Docker image, optional PM2 configuration, a pooled MongoDB connection (`maxPoolSize: 10`, `serverSelectionTimeoutMS: 10000`), production `autoIndex: false`, and a Client API URL configured through `NEXT_PUBLIC_API_BASE_URL`. These do not identify the actual host, subscription, TLS termination, environment-secret store or fleet version. The local development Compose replica set is not evidence about production. Do not copy development HTTP/cookie settings into a deployment.

## Enrollment gate

`TWO_FACTOR_ENROLLMENT_ENABLED` defaults to `false`. Keep it false until every rollout step below is satisfied. The flag is an operator attestation that the external checks were completed; it does not inspect subscriptions, every serving binary, the public API's TLS certificate, server clock synchronization or available storage.

Setup and activation both require the flag, a configured dedicated key, secure cookies/HTTPS frontend in production, and read-only MongoDB metadata showing transaction-capable topology and the required complete unique/TTL indexes. A failed or inaccessible check returns generic 503 `TWO_FACTOR_ENROLLMENT_UNAVAILABLE`. No index is created or repaired automatically. Metadata checks occur only at setup/activation, not on every protected request or login, and have a server-side 3-second maximum per command in addition to the existing driver's connection-selection timeout.

Turning this flag off also stops completion of pending setup. It does **not** skip challenges for enabled users, erase factors, disable recovery-code login/management or re-enable revoked sessions. Existing factor verification remains fail-closed if its required key/database is unavailable. Metadata is a capability check, not proof that actual transaction permissions, latency, storage and scheduling have been verified.

## Dedicated key: generate once, configure and retain

1. Use the existing protected deployment-secret mechanism. Assign an authorized operator and confirm that interactive/CI output, shell tracing and transcripts cannot capture the value. Do not generate a key during ordinary application startup.
2. Use free local Node.js cryptographic tooling to generate exactly 32 random bytes and encode them as 64 hex characters. The following is an **operator template**, not a command run by this sprint. Replace the sink with the existing secret tool's reviewed stdin ingestion command; do not run the generator alone in a logged console:

   ```sh
   node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" | EXISTING_SECRET_INPUT_COMMAND
   ```

   No sink is supplied because the repository does not establish which secret mechanism the deployment uses. If its UI only supports manual entry, use its existing authorized, unrecorded secret-entry procedure. Never send the value through chat, issue comments, application logs, command-line value arguments or a committed `.env` file.
3. Store as `TOTP_ENCRYPTION_KEY_V1`; make the identical value available to every serving API instance. Never prefix it with `NEXT_PUBLIC_` or put it in the Client build environment. Keep the enrollment flag false while configuring it.
4. Retain a separately protected, encrypted backup of this exact key using already available storage/tools. Record its version, custodian, backup date and retrieval procedure without recording its value in tickets. Ensure an authorized second custodian can recover it. Verify recoverability using test material under a separately approved procedure; do not expose the production key for a demonstration.
5. Replacing V1 in place makes existing authenticator secrets unreadable. Rotation requires a separately reviewed version-aware re-encryption plan. Losing the key is not repaired by generating a different key. Valid recovery codes remain second factors, not password-only fallback.

## Required ordinary MongoDB collection and indexes

The model uses collection `twofactorchallenges`. It defines a unique single-field `tokenHash` index and an `expiresAt` TTL index with zero expiration offset. No paid index type is involved. Application queries independently enforce expiry and attempt limits; TTL deletion is asynchronous. [MongoDB TTL documentation](https://www.mongodb.com/docs/manual/core/index-ttl/)

An authorized operator must review the target database and permissions first. These are **manual provisioning examples**, not scripts executed by the API or this task. Use the existing approved authenticated `mongosh` connection without putting its URI/password in a shell-history command. Select the reviewed application database rather than `admin`.

```javascript
// Replace the placeholder after independently confirming the target application database.
const applicationDb = db.getSiblingDB("REVIEWED_APPLICATION_DATABASE");
// Create only if absent; inspect existing collection options before proceeding.
if (applicationDb.getCollectionInfos({ name: "twofactorchallenges" }).length === 0) {
  applicationDb.createCollection("twofactorchallenges");
}
applicationDb.twofactorchallenges.createIndex(
  { tokenHash: 1 }, { name: "tokenHash_1", unique: true }
);
applicationDb.twofactorchallenges.createIndex(
  { expiresAt: 1 }, { name: "expiresAt_1", expireAfterSeconds: 0 }
);
applicationDb.twofactorchallenges.getIndexes();
```

If duplicate hashes, an index-options conflict, unsupported topology, missing privileges or storage exhaustion occurs, stop with enrollment disabled. Do not delete evidence, drop indexes or weaken uniqueness to make provisioning pass. The gate accepts equivalent index names but rejects compound substitutes, partial/sparse coverage and a different TTL interval. The existing broad `pnpm sync:indexes` script can drop/reconcile unrelated indexes and is not part of this targeted runbook; do not run it automatically.

## Ordered rollout on existing infrastructure

1. Inventory the actual API/Client hosts and database tier without changing them. Confirm no billable upgrade/resource/trial is needed. Check current capacity and that the existing environment-secret mechanism can retain one stable secret across restarts. Missing evidence is a verification blocker, not permission to spend.
2. Keep `TWO_FACTOR_ENROLLMENT_ENABLED=false` on **all** instances. If an old binary does not implement this switch, block enrollment paths at the existing ingress or cut traffic to it. A flag cannot control an old implementation that ignores it.
3. Perform an approved free manual backup if existing storage/tooling permits it. Keep the key backup independently protected. Review the backup limitations below.
4. Configure the dedicated key on every API instance through existing secrets. Verify HTTPS API ingress, secure cookies, correct cookie domain/path/SameSite behavior, exact HTTPS `FRONTEND_BASE_URL`, credentialed CORS, correct Client `NEXT_PUBLIC_API_BASE_URL`, proxy trust and reliable host time. HTTP frontend or `AUTH_COOKIE_SECURE=false` in production blocks enrollment; public API TLS and clock still require operator evidence.
5. Provision/review the application collection and ordinary indexes through a separately approved operation. The current production connection does not auto-build them. Application User/Session optional fields need no data migration.
6. Verify actual replica-set transaction permissions and capacity under the deployment's separately approved acceptance process. Do not replace transactions, weaken majority acknowledgement, extend timeouts to mask overload, or fall back to sequential status/session writes. None of those checks are run in this code-only task.
7. Deploy the matching Client and cut over the entire API fleet to binaries that enforce 2FA and the gate. Drain old workers/processes that serve authentication traffic; verify the artifact/version at each serving instance. Do not allow an old authentication API to serve already-enabled users. Paid hosting migration is not authorized.
8. Verify the current contracts through the separately approved deployment acceptance process: password and each configured professional OAuth flow challenge before session issuance; QR/manual setup; recovery/last-code replacement; safe management; ordinary refresh; suspension; and rollback behavior. This task performs no browser/live-provider or real-database checks.
9. Only an authorized operator, after recording every prerequisite, may explicitly set the flag true on the serving fleet. That activation is **not** performed or authorized by this sprint. If any prerequisite cannot be met for free, leave it false and record the precise blocker.
10. For a rollout issue, first stop new enrollment everywhere. Preserve the key, all enabled-account enforcement and the required database state. Roll back only to a compatible binary that enforces existing 2FA. If none is available, stop affected authentication traffic; never restore a pre-2FA API to service enabled accounts. Do not clear factors or revive old sessions as rollback.

## Free-plan resource budget

The documented M0 budget includes 512 MB combined data/index space, shared compute, 100 database operations/second and at most 500 connections; these are cluster-wide limits. Ten pooled application connections per API process plus monitoring connections must fit the actual deployment. A database operation is not the same as an HTTP request. [Atlas tier comparison](https://www.mongodb.com/docs/atlas/manage-clusters/), [Free limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/)

2FA reuses User/Session storage and one compact, five-minute pre-auth collection. Recovery verifiers are a fixed set of ten; security events use existing structured logs rather than another database audit collection. TTL cleans challenge rows without a worker, while application expiry prevents their use even if deletion is delayed. Session TTL remains unchanged. Shared compute/throttling may increase latency and transaction retries; no guaranteed request capacity or availability is claimed. The usual transaction runtime default is under one minute, not the five-minute challenge lifetime. [Transaction runtime limits](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/)

Use existing free host/Atlas visibility to record database logical/index size, connection count, operation/transaction errors, latency and TTL backlog. No new paid monitoring is required. If the application no longer fits the free budget, pause new enrollment and reassess safely; do not silently alter retention/security invariants or approve an upgrade.

## Manual backup process and recovery limitations

There is no included automatic backup assumption. MongoDB now documents an **optional paid backup subscription for Free clusters**; enabling it starts billing. Do not enable it under this policy. [Free Cluster Backups](https://www.mongodb.com/docs/atlas/backup/cloud-backup/free-cluster-backup/)

1. Use an existing authorized machine, installed/free MongoDB Database Tools, sufficient existing disk, and an already approved encrypted offline destination. If those are unavailable at zero additional cost, record a backup blocker rather than buying storage.
2. Schedule an approved maintenance window and coordinate all writers for the full application database, including background jobs, so related collections do not change during the export. This document does not start/stop any service. M0 `mongodump --oplog` is unsupported; a normal dump during concurrent writes is not a guaranteed consistent multi-collection snapshot. [Atlas tool restrictions](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/)
3. Obtain the connection details through existing secret handling and a protected tool configuration file outside the repository. Do not place the URI/password on the command line or export the `admin` database. Example only, after separate approval:

   ```sh
   mongodump --config /protected/backup-config.yml --db REVIEWED_APPLICATION_DATABASE --archive=/protected/bookly-reviewed-date.archive.gz --gzip
   ```

4. Protect/encrypt the archive with existing OS encryption or available free local cryptographic tools; restrict ACLs before writing it. Store the encrypted copy on existing offline media separately from the live database and retain the matching TOTP key securely, not in the same unprotected bundle. Record checksum, tool/database version, timestamp, scope, size and custody without secrets or exported contents. Protect backup configuration and any intermediate plaintext through the existing secure handling procedure.
5. Record manual cadence/retention approved by the Owner and missed-backup alerts through existing processes. Check available storage before every run. A backup has a recovery-point gap, depends on human execution and has no continuous/PITR or tested restore guarantee merely because a file exists. No backup/restore was run here.
6. Restore is a separate approved security/data-recovery operation, not a command to run from this runbook. A stale backup can restore consumed recovery codes, revoked sessions or old suspension state. Keep serving authentication and relevant writers stopped until an approved reconciliation preserves restrictions and prevents credential resurrection. If code-consumption state cannot be established, keep affected access closed pending an approved recovery/re-enrollment policy. Never restore an old auth snapshot directly into a serving fleet and assume prior revocation remains intact.

Zero-factor support review remains the separate [draft recovery policy](2fa-manual-recovery-policy.md). No factor reset is authorized by backup possession, a support ticket or an approval-to-review decision.
