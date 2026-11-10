# Reliable Google Calendar sync: free-tier activation runbook

**Status:** prepared on 8 November 2026 for operator review (updated for P2.2.9.2). Nothing in this document has been executed. No index, deployment, worker, Google call or authority change is authorized by this document alone.

**What this activates:** the existing reliable one-way path (Bookly → Google) for Normal and Legacy Package Bookings. That path is made of:
- the journal: `OrdinaryCalendarJournal`
- the consumer: `OrdinaryCalendarDispatch`
- the worker: `run-ordinary-calendar-worker.ts`

First-Class Package Calendar delivery (P2C) is separate and is not activated here.

**Until every step below is complete**, production keeps the best-effort path:
- one attempt per Booking change, with failures shown to the Owner;
- both authorities in `src/modules/booking/ordinary-calendar-journal-authority.ts` keep denying.

## 0. Free-only constraints

- Use only:
  - **Host:** the existing API host.
  - **Database:** the existing MongoDB (Atlas Free/M0 is a transaction-capable replica set).
  - **Google:** the existing Google Cloud OAuth client and its free Calendar API quota.
- Do not buy a worker, scheduler, queue, Redis, monitoring or database upgrade.
- If the existing host cannot run one extra small Node process or a scheduled command, **stop here**. Keep both authorities denied and record that as the deployment blocker. Do not replace the worker with retries triggered by web requests.

## 0.1 Hosting status (P2.2.9.2)

**`HOST_CAPABILITY_UNVERIFIED`.**

- **No production host in the repository.** The repository contains no production host manifest: no provider config, systemd units, cron or scheduler definitions, or deployment pipeline.
- **What exists:** the generic Docker image (its `CMD` starts the API only) and PM2 files.
- **Hetzner:** `BOOKLY-P4I-HETZNER-LINUX-PRODUCTION-COMPOSITION-RESULT.md` records Hetzner Linux as the **selected** target, but "not provisioned or qualified". So no plan, server size, process limits or scheduler is evidenced.

**The single missing fact:** which existing host and plan will run the API, and whether that machine is an always-on VM where one extra Node process or a cron or systemd timer is allowed at no additional charge.

A plain Linux VM, which is what Hetzner provides, normally satisfies both options below and does not sleep. That must be confirmed on the real machine. Do not choose a platform that sleeps idle instances for the worker.

## 1. Read-only readiness check

From the deployed build, using the production environment:

```sh
node dist/scripts/run-ordinary-calendar-worker.js --check
# development equivalent: pnpm calendar:readiness
```

It logs `ORDINARY_CALENDAR_ACTIVATION_READINESS` with one result per check, and exits `0` only when the infrastructure checks pass.

| Check | Passes when |
| --- | --- |
| `JOURNAL_INDEXES` | Both indexes exist with exact key order and options. Missing and conflicting indexes are named. |
| `TRANSACTION_CAPABLE_DATABASE` | `hello` reports a replica set or mongos with logical sessions |
| `GOOGLE_OAUTH_CONFIGURED` | Client id, secret and redirect URI are present (values are never printed) |
| `TOKEN_ENCRYPTION_KEY_CONFIGURED` | `GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY` is present |
| `DELIVERY_AUTHORITY` / `CREATION_AUTHORITY` | Expected **Denied** before the activation release |

What the check does **not** do:
- **No changes:** it never writes, creates or repairs indexes, calls Google or delivers anything.
- **No secrets:** it prints no hostnames or secrets.

The report also lists the **manual gates** that code cannot observe (section 7).

## 2. Index provisioning (once, under approval)

**Collection:** `ordinarycalendarjournals`. Production runs with `autoIndex: false`. **Never run `sync-indexes.ts`.**

### Inspect first (read-only)

```js
db.ordinarycalendarjournals.getIndexes()
```

If the collection does not exist yet, `createIndex` creates it.

### Then create exactly these two indexes

```js
db.ordinarycalendarjournals.createIndex({ bookingId: 1 }, { name: "bookingId_1", unique: true })
db.ordinarycalendarjournals.createIndex(
  { mode: 1, state: 1, nextAttemptAt: 1 },
  { name: "mode_1_state_1_nextAttemptAt_1" },
)
```

- **Idempotent:** `createIndex` with an identical spec is a no-op.
- **No conflicting options:** do not add `partialFilterExpression`, `sparse`, `collation`, TTL or `hidden`. Readiness rejects all of them, because they would let duplicate rows through or hide due rows.
- **If the check reports a conflict**, for example a non-unique `bookingId_1`: stop and review that index manually. Dropping or replacing an index is a separate approved change.
- **Before activation, the collection is empty**, because nothing writes it while the authorities deny. The unique build therefore cannot fail on existing data.
- **Atlas M0** supports ordinary indexes, within the 512 MB combined data and index budget.

**Optional, for large Businesses:** `{ businessId: 1, state: 1, confirmedAt: -1 }` (name `businessId_1_state_1_confirmedAt_-1`). It serves the Owner status summary. It is not required for correctness, and readiness does not require it.

Re-run the check (section 1). `JOURNAL_INDEXES` must pass.

## 3. Worker runtime on the existing host (choose one)

The worker is safe on any cadence:
- leases, durable "request issued" records and the one-time send permission make overlapping runs safe;
- each pass is bounded to 25 due rows, processed serially;
- uncertain outcomes are never re-sent blindly.

It **refuses to start** in two cases:
- the delivery authority is denied (before connecting);
- either index is missing or conflicting (after connecting).

| Option | Command | Fits when |
| --- | --- | --- |
| **A. PM2 process** (preferred) | `pm2 start ecosystem.ordinary-calendar.config.cjs` | The host already runs PM2 for the API and can afford one more ~256 MB Node process. Single fork instance, polls every 30 s, drains for 70 s on stop. |
| **B. Host scheduler** | `node dist/scripts/run-ordinary-calendar-worker.js --once` every 1–5 minutes | The host already has a free cron or scheduled-command facility. Each run makes one bounded pass and exits. The longest backoff is 6 h, so a few minutes' cadence only adds a few minutes of latency. |
| **None available** | — | Keep both authorities denied. Record the blocker. The best-effort path stays live and Owners still see failures. |

**Exit codes:**

| Code | Meaning | Restart? |
| --- | --- | --- |
| 0 | Normal stop, or `--once` finished | No |
| **78** | Deliberate refusal: authority denied, or journal not provisioned (logs `ORDINARY_CALENDAR_WORKER_REFUSED` with the reason) | **No.** `ecosystem.ordinary-calendar.config.cjs` sets `stop_exit_codes: [78]` |
| 1 | Genuine failure | Yes, bounded by `max_restarts: 10` |

**Option A (PM2):**
- **Command:** `cd api && pnpm build && pm2 start ecosystem.ordinary-calendar.config.cjs && pm2 save`.
- **Environment:** the worker loads the same `api/.env` as the API (`cwd` is the `api` folder; `src/config/env.ts` imports `dotenv/config`), so it uses the same database and Google settings.
- **Stop:** `pm2 stop bookly-ordinary-calendar`. The stop is graceful: SIGTERM means no new claims, the in-flight delivery drains, and there is a 70 s kill timeout.

**Option B (host scheduler, Linux):** one pass every 2 minutes, with `flock` so a slow pass is never overlapped, and a bound so a hung pass is stopped gracefully:

```cron
*/2 * * * * cd /srv/bookly/api && flock -n /tmp/bookly-ordinary-calendar.lock timeout --signal=TERM --kill-after=70s 10m node dist/scripts/run-ordinary-calendar-worker.js --once >> /var/log/bookly/ordinary-calendar.log 2>&1
```

The leases already make overlap safe; `flock` only avoids wasted passes. Exit 78 under cron simply means "not activated"; nothing retries it.

**Notes:**
- Do not run the worker from the API web process, and do not rely on a sleeping free web instance.
- Several instances are safe but not useful; run one.
- Worker logs to route to alerts (D3): `ORDINARY_CALENDAR_INCIDENTS` (counts by category), `ORDINARY_CALENDAR_DELIVERY_FAILED`, `ORDINARY_CALENDAR_WORKER_PASS_FAILED`, `ORDINARY_CALENDAR_WORKER_STOPPED_WITH_DUE_WORK`, `ORDINARY_CALENDAR_JOURNAL_NOT_READY`.

## 4. Google sandbox qualification (separately authorized calendar)

Run against a dedicated test Google account and calendar, connected to a test Business, with both authorities enabled **only in a non-production deployment**. Record the evidence for each row:

| # | Scenario | Expected |
| --- | --- | --- |
| 1 | New UPCOMING Booking | One event with id `o<bookingHex>`, the private marker `booklyBookingId`/`booklyBusinessId`, and start/end with `timeZone` set to the Booking timezone. Journal row CONFIRMED with `confirmedAt` set. |
| 2 | Insert of an id that already exists. In the **sandbox calendar only**, create the event `o<bookingHex>` beforehand with the Calendar API "Try it" console, carrying the Booking's private marker. Do **not** edit journal rows by hand. | Google returns 409, so ALREADY_EXISTS, then read-back, then CONFIRM (owned) or block (unowned, row 13). No second event. |
| 3 | ETag mismatch (edit the event in Google, then reschedule in Bookly) | 412, so PRECONDITION_FAILED, then re-observe. Ownership is still verified before PATCH. |
| 4 | Reschedule | Same event PATCHed. Instants are correct in winter and summer and across the DST change. |
| 5 | Cancellation | Conditional DELETE. Redelivery never recreates the event. |
| 6 | Deleted-event tombstone (delete in Google, then redeliver an issued create) | Blocked (`MISSING_EVENT_DOES_NOT_AUTHORIZE_RECREATE`). Never re-inserted. |
| 7 | Timeout after a successful insert (network cut after send, in the test environment) | UNKNOWN_OUTCOME, then read-back confirms. One event. |
| 7b | Ambiguous 5xx on a write (a proxy returning 503 after forwarding) | UNKNOWN_OUTCOME; never re-sent blindly; the next pass reads back and confirms or blocks for Owner recovery |
| 8 | Rate limit (burst to 429) | RETRYABLE; `nextAttemptAt` is at least the Retry-After; backoff doubles. |
| 9 | Retry limit (10 consecutive failures in a test) | `RETRY_LIMIT_REACHED`. Owner panel shows "Needs your attention"; recovery reopens the row. |
| 10 | Revoked grant (revoke access at myaccount.google.com) | Integration becomes `RECONNECT_REQUIRED`. No further Google calls. Settings shows Reconnect. |
| 11 | Reconnect, same account | Rows blocked on the old generation are resumed by Owner recovery (`rebindToCurrentConnection`). |
| 12 | Reconnect, different account | Existing events are never adopted, moved or deleted. Rows stay "Needs your attention". |
| 13 | Event not created by Bookly at the deterministic id (manual collision) | `EVENT_OWNERSHIP_STATUS_OR_ETAG_UNVERIFIED`. Never modified. |

## 5. Activation order (code release, after sections 1–4)

**Condensed sequence:**
1. Prepare compatible API and Client releases.
2. Verify the database and runtime prerequisites (section 1 `--check`, section 2).
3. Establish the worker on the existing host (section 3); with authority denied it must exit 78.
4. Enable the **delivery** authority (reviewed release).
5. Verify readiness and worker health: passes logged; no `ORDINARY_CALENDAR_WORKER_PASS_FAILED`.
6. Enable the **creation** authority (reviewed release), only after step 5.
7. Verify that new eligible Bookings are journal-owned: the per-Booking status shows `JOURNAL`.
8. Verify single ownership: no `googleCalendarEventId` on journal-owned Bookings; legacy Bookings stay `LEGACY_UNTRACKED`.
9. Monitor the Settings card counts and the incident logs.

**Detailed steps:**


1. Deploy the current release with both authorities denied. Verify that existing Bookings report `LEGACY_UNTRACKED` and that the readiness check passes on infrastructure.
2. Start the worker (section 3). It must refuse while delivery is denied.
3. Release a reviewed change to `ordinary-calendar-journal-authority.ts` that grants **delivery first**. Then, in a later release (or the same reviewed one), grant **creation**. Only Bookings created after that are journal-owned. Legacy Bookings keep the best-effort path, and no Booking ever has two writers.
4. Watch the Settings card and incident logs for 24 h.

**Rollback:**
1. Deny creation first.
2. Keep delivery and the worker running until journal rows settle.
3. Never re-enable legacy writes for journal-owned Bookings (enforced by `legacySyncPermitted`).

## 6. Policies (**Owner-approved 8 November 2026**: D1, D2, D3 and retry; final)

| Policy | Implemented baseline |
| --- | --- |
| **D1:** journal persistence | The intent is written inside the Booking transaction (enforced). If it cannot be saved, the Booking change aborts and is never reported as having a durable intent. A Google failure *after* commit never rolls a Booking back. Before activation, best-effort behavior is unchanged and no journal I/O happens. |
| **D2:** disconnected or changed destination | No automatic move, recreate, adopt or delete across Google accounts. Connection-generation fencing. Same-account rebind and unused-destination bind are explicit per-Booking Owner recovery actions. Events left in an old account stay there and are shown as "Needs your attention". |
| **D3:** alerts | Owner: the Settings card shows reconnect required, sync failed, and counts of pending, retrying and needs-attention bookings (with retry-limit and rejected-by-Google subsets), plus the last confirmed sync. The per-Booking panel shows the incident and the recovery form. Operator: the worker log events (section 3), routed through existing free log alerting. No paid e-mail, SMS or monitoring. |
| **Retry** | 1 min transient base; 15 min uncertain base; ×2 per consecutive failure; ±20% jitter; 6 h ceiling; Google Retry-After honored up to 24 h; after 10 consecutive failures, Owner attention is required (`RETRY_LIMIT_REACHED`). Only confirmation or Owner recovery resets the counter. |

## 7. Manual gates (must be recorded before step 5.3)

- `GOOGLE_SANDBOX_QUALIFICATION_RECORDED`: section 4 evidence
- `WORKER_RUNTIME_PROVISIONED_ON_EXISTING_FREE_HOST`: section 3, option A or B
- `OWNER_RATIFIED_D1_D2_D3_AND_RETRY_POLICY`: section 6
- `ALERT_ROUTING_REVIEWED`: section 3 log events
- `ALL_API_INSTANCES_ON_COMPATIBLE_RELEASE`
- `GOOGLE_CALENDAR_API_QUOTA_REVIEWED`: the free per-project and per-user limits fit the expected Booking volume

## 8. Not covered here

- First-Class Package Calendar (P2C) production authority and trusted-time prerequisites
- First-Class purchase authority
- Two-way sync, import or availability blocking
