# Transactional email worker runtime contract

Source prepared 26 October 2026 (F4A). **NOT VERIFIED. No activation or deployment authorized.**

## What the worker does

`src/scripts/run-email-worker.ts` drains the existing `EmailOutbox` collection. Domain code
(Booking created / cancelled / rescheduled / completed, staff, package, client and business
notifications) inserts rows; the worker claims a row, renders its template from the row's
stored payload, calls the configured provider (`EMAIL_PROVIDER`: sendgrid | resend | smtp) and
records the result. It never creates Booking events, recipients or payloads.

## Explicit activation

The default `ecosystem.config.cjs` and the Docker `CMD` still start only the API. The
separate `ecosystem.email-worker.config.cjs` describes one forked Node process,
`bookly-email-worker`, running `dist/scripts/run-email-worker.js` (output of the existing
`src` → `dist` build; artifact existence and production dependency closure still need a
trusted build). The package `worker:email` scripts use `tsx`, a development dependency;
do not use them in production.

The worker refuses to start unless the operator supplies, through the target's approved
configuration mechanism:

```text
BOOKLY_EMAIL_WORKER_ENABLED=true
EMAIL_PROVIDER=sendgrid|resend|smtp      # explicit; a defaulted provider is refused
MONGODB_URI=...                          # nonempty
```

plus the selected provider's settings (sendgrid: `SENDGRID_API_KEY`, `EMAIL_FROM`; resend:
`RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_FROM_NAME`; smtp: `SMTP_HOST`, `SMTP_USER`,
`SMTP_PASS`, `EMAIL_FROM`). The ecosystem file sets none of these. Shared validation in
`src/config/env.ts` still runs first and stays authoritative. Only the optional `--once`
argument is accepted. The same gate applies to direct CLI and `pnpm worker:email` runs.

Activating the worker sends real email to real recipients of already-queued rows. Before
activation, review the PENDING backlog: rows queued while no worker ran will be sent.

## Process topology

- One `bookly-email-worker` process per environment is the supported configuration.
- The atomic `claimNext` means two consumers never hold the same claim at once, so an
  accidental second consumer does not double-claim. It can still widen the duplicate
  window described below, and it is not needed for throughput (`EMAIL_WORKER_CONCURRENCY`).
- No flag here is a distributed lease. The gate does not detect other hosts.

## Lifecycle

- Passes run serially: the next pass starts `EMAIL_WORKER_POLL_INTERVAL_MS` after the
  previous one fully settles (the old `setInterval` could overlap passes).
- SIGINT/SIGTERM: no new rows are claimed; sends already in flight finish and record their
  outcome; then the database disconnects. The old handler disconnected and called
  `process.exit(0)` mid-send, leaving accepted emails unrecorded.
- PM2 `kill_timeout` is 60 s, shorter than the 120 s `EMAIL_OUTBOX_CLAIM_TIMEOUT_MS`
  default. Keep that ordering if either value changes. A hard kill leaves the row
  PROCESSING until its claim expires, then it is retried.
- Logs carry counts, template key, event key, masked recipient and safe error categories.
  Pass and startup failures log an event code, never the raw exception.

## What the stored status means

| Stage | Evidence Bookly holds |
|---|---|
| Booking committed | Booking document (domain transaction) |
| Notification enqueued | `EmailOutbox` row, `PENDING`, unique `dedupeKey` |
| Worker claimed | `PROCESSING`, `claimedBy`, `claimedAt`, `attemptCount` incremented |
| Provider accepted | `SENT`, `sentAt`, `provider`, optional `providerMessageId` |
| Recipient delivery | **Not tracked.** No webhook or receipt is consumed. |

`SENT` means the provider accepted the request. It is never proof of inbox delivery.
`FAILED` with `lastErrorCategory=CLAIM_ABANDONED_OUTCOME_UNKNOWN` means the final attempt's
claim expired without a recorded result: the email may or may not have been accepted.

## Delivery guarantee: at-least-once, not exactly-once

No provider idempotency key is sent. If a worker gets provider acceptance and then dies, or
its send takes longer than the claim timeout, the row can be sent again. Mitigations in
source: acceptance is recorded even if the claim was reset to PENDING; retry/failure writes
are fenced to the claim that made them; a persistence error after acceptance is never
turned into a retry. These narrow the window; they do not close it.

## Known gaps (not changed by F4A)

- Booking-created notifications are enqueued after the Booking transaction commits and
  after the Google Calendar call, best-effort. A crash between commit and enqueue loses the
  email; no outbox row is written inside the Booking transaction.
- Transports set no explicit request timeout; a hung provider call holds a claim until the
  process is killed.
