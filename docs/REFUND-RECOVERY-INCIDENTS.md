# Refund recovery incidents (P5-F1)

Source implementation only. Tests/typecheck/build/database/provider/worker checks NOT RUN. No worker, mail destination or production index was activated by this change.

## Scope and correlation

MoneyRecovery's existing refund failure and final-notification convergence passes observe operational incidents on the exact RefundOperation. No PaymentAttempt, ledger, Booking settlement, Package progress, provider state or final-notification marker is changed by the monitor. Existing refund retry and idempotency logic is retained.

The embedded `recoveryIncident` holds OPEN/RESOLVED state, episode ObjectId, latest stage classification, first/last observation times, observation count, sweep timestamp, alert-intent timestamp, resolution timestamp and evidence timestamps seen at observation. One document per RefundOperation means concurrent observations cannot create duplicate incident records. Repeated observations increment a counter, not an array of errors. A recurrence after RESOLVED creates a new episode. The embedded record stores the latest episode; prior transition logs/outbox rows remain separately identifiable by episode. This is not a new financial ledger or a full incident-history archive.

Classifications:

- `REFUND_RECOVERY_FAILED`: the existing refund/accounting/authority recovery step failed; this does not assert which evidence is correct or that another refund is owed.
- `FINAL_NOTIFICATION_EVIDENCE_UNRESOLVED`: the P4B-1R exact-evidence helper returned NOT_READY; conflicting or missing financial/identity/projection evidence requires inspection.
- `FINAL_NOTIFICATION_RECONCILIATION_FAILED`: projection/outbox/notification convergence threw; transient infrastructure failure is possible, so this is not presented as a proven monetary contradiction.

Business/Booking/source PaymentAttempt correlation comes only from the RefundOperation, never a caller-supplied association. Missing Business correlation is reported as null, not inferred. Logs and alerts use internal identifiers and fixed classification/guidance only, with no amounts, Customer identities/contact, raw exceptions, provider payment/refund identifiers, keys or idempotency secrets.

## Explicit alert configuration

All three environment settings are required together on an approved worker deployment:

| Setting | Contract |
| --- | --- |
| `BOOKLY_REFUND_INCIDENT_ALERT_RECIPIENTS` | Comma-separated approved operator email destinations; normalized and deduplicated |
| `BOOKLY_REFUND_INCIDENT_ALERT_MIN_OBSERVATIONS` | Explicit positive safe integer observation threshold |
| `BOOKLY_REFUND_INCIDENT_ALERT_MIN_AGE_MS` | Explicit nonnegative safe integer minimum age in milliseconds |

There are **no default recipients or thresholds** and no fallback to hardcoded internal support mailboxes. Both thresholds must be satisfied. With all settings absent, durable observation, structured logs and the operator read API still work, while email escalation is unconfigured. Startup emits `REFUND_RECOVERY_INCIDENT_ALERTS_UNCONFIGURED`. Partial, blank or invalid configuration fails worker construction with a sanitized error. Values used in tests are synthetic, not deployment recommendations.

Alerts reuse EmailOutbox and the existing registered `FINANCE_SUPPORT_ALERT` template with kind `REFUND_RECOVERY_CONFLICT`. Their event identity is `REFUND_INCIDENT:<RefundOperationId>:<episodeId>`, deduped per recipient by the existing outbox unique key. An incident document write is taken before enqueue inside a majority/journaled snapshot transaction; the intent timestamp and all recipient outbox rows commit together or roll back. No provider is called here. Monitoring failures increment the existing recovery error count and emit sanitized failure events rather than canceling financial recovery or asserting an alert was sent.

`alertedAt` in storage / `alertIntentRecordedAt` in the API means intent queued, **not delivery**. Existing outbox workers/claim fences/unknown-outcome handling retain delivery authority. A queued alert describes an observed incident and directs operators to current state; it may have resolved before delivery. Changing recipients/thresholds does not resend an already queued episode. Reminder cadence/escalation levels and destination-change re-notification require separate policy decisions.

## Operator access

`GET /super-admin/finance/refund-recovery-incidents` is mounted after the existing live-session, ACTIVE account and SUPER_ADMIN gate. No Owner/Supervisor/Staff/Customer access is added. Query: `state=OPEN|RESOLVED` (default OPEN), optional Business ObjectId, bounded `page` and `limit` (max 50); unknown query keys are rejected. Response includes only correlation ids, current episode state/classification/count/timestamps, intent timestamp and fixed recovery guidance. No raw RefundOperation, provider data, financial amounts or exception text is serialized. Successful reads are `private, no-store`. There is no acknowledge/resolve/retry/refund mutation endpoint or Client UI in this scope.

Inspect the RefundOperation, associated Business/Booking, source attempt, source/refund ledger and exact P4B-1R notification evidence together using existing authorized finance tools. Preserve conflicting records. Do not edit markers/statuses, repeat provider requests, refund again or replay historical mail to silence an alert.

## Evidence-only incident resolution

A separate bounded fair sweep checks OPEN incidents even after ordinary recovery queues no longer return an operation. An opted-in ordinary cancellation can resolve its incident after a newly committed canonical final-notification marker, distinct from the marker observed with the conflict, and no older than the latest observation. A stale NOT_READY notification observation after that marker committed does not create a new incident. Resolution can reflect authoritative FAILED evidence; it never means a refund succeeded.

For a non-opt-in, non-Package operation, resolution additionally requires newly reconciled SUCCEEDED provider evidence, no reconciliation-needed marker and an exact successful refund ledger match on operation identity, Business/Booking/client/customer, currency, amount, provider refund reference and source reference when present. A preexisting marker, mere provider success or elapsed time is insufficient. Package authority incidents remain OPEN rather than treating matching monetary rows as Package permission. No operator force-clear or Package-specific authority resolver was invented.

Evidence timestamps are operational freshness fences, not a replacement for the First-Class trusted clock. Ambiguous or old/same-timestamp evidence can conservatively leave an incident OPEN. All resolution writes affect only the incident state. The monitor disables root timestamps on its metadata writes so it does not reorder existing financial retries by changing RefundOperation.updatedAt.

## Database rollout and remaining decisions

One additive index is declared: `{"recoveryIncident.state":1,"recoveryIncident.lastCheckedAt":1,_id:1}`. Existing RefundOperation/_id and EmailOutbox uniqueness enforce deduplication independently. The new index supports bounded fair sweeps/read ordering; provision it separately only with Owner authorization. Do not run broad syncIndexes, migrations or historical data rewrites. Existing records remain without incidents until an actual recovery observation occurs; there is no historical alert backfill/replay.

Before deployment, approve recipients, thresholds, alert ownership/on-call, persistence/log retention and the additive index. Decide whether a full episode-history archive, incident console, acknowledgment/escalation workflow or Package-specific/manual evidence closure is needed. No numerical production policy, new financial authority or deployment permission is supplied here.
