# Stripe payout observations and history coverage (FG03B-1)

Status: **source only. Not provisioned, not enabled, no backfill run.** LIVE central withdrawals are still denied in source, and nothing here changes that.

## What this adds

- **`stripepayoutobservations`**: one non-monetary record per Stripe payout per mode (TEST or LIVE).
  - Records come from verified `payout.*` webhooks and from the history sync.
  - Each record carries a linkage:
    - `VERIFIED_BOOKLY`: a withdrawal operation records this exact payout id in the same mode.
    - `UNRESOLVED`: the metadata names an unconfirmed Bookly operation.
    - `NOT_VERIFIED`: anything else.
  - A record is not a ledger entry, not a withdrawal operation, and not proof of ownership, authorization or bank receipt.
  - Stored data is minimal: no metadata payload, no bank numbers, and no provider failure text.
- **`stripepayouthistorycoverages`**: one checkpoint per mode for the bounded, resumable history read. It holds:
  - the Stripe account id the coverage belongs to (coverage resets when the account changes);
  - the cursor of the run in progress;
  - `completeAsOf`;
  - the last error;
  - a lease, so only one run proceeds at a time;
  - a capped audit trail.
- **Webhooks**: `payout.*` events that do not match a Bookly operation are now recorded as observations instead of being ignored. Event deduplication, the signature check and the operation status rules are unchanged. No withdrawal operation is ever created for an external payout.
- **Readiness**: `GET /super-admin/finance/withdrawals/overview` now includes `reconciliation`. It is built from database reads only and is never a permission. `evidenceComplete` is false whenever any of these is true:
  - the history has never been read, or the read is unfinished or failed;
  - the Stripe account changed or could not be identified;
  - there are unverified or unresolved payouts;
  - withdrawals are awaiting confirmation;
  - payouts are still in flight.

## Coverage semantics

- A history run reads Stripe's payout list newest first with cursor pagination, at most 10 pages of 100 per request.
- It is marked `COMPLETE` only when Stripe returns `has_more: false`.
- A provider error, a mode mismatch, an empty page that claims more results, or a lost lease all leave the coverage `IN_PROGRESS`. The pages already read stay recorded, and the next request resumes from the saved cursor.
- `completeAsOf` is the server time the completed run started. Payouts created later are covered only by webhook delivery until the next completed run, which re-reads from `completeAsOf` minus 24 hours (re-reading is idempotent).

## Additive provisioning required before enabling (production `autoIndex` is off)

| Collection | Index | Options |
| --- | --- | --- |
| `stripepayoutobservations` | `{ mode: 1, providerPayoutId: 1 }` | `unique: true` |
| `stripepayoutobservations` | `{ mode: 1, linkage: 1 }` | |
| `stripepayoutobservations` | `{ mode: 1, status: 1 }` | |
| `stripepayouthistorycoverages` | `{ mode: 1 }` | `unique: true` |

Create these with an approved targeted index operation, not a broad sync of every model. Webhook observations start being written as soon as the new API is deployed, so **create the unique observation index before deploying**. Without it, concurrent first deliveries could create duplicate observation records (no money is affected).

## Enabling the history read

The history read stays disabled until all of the following are true:

1. The indexes above exist on the target database.
2. The API release containing this change has been deployed through the normal approved procedure.
3. The Owner approves running the read.

Only then set `CENTRAL_PAYOUT_HISTORY_SYNC_ENABLED=true`. The operator then calls `POST /super-admin/finance/withdrawals/provider-history/sync` (Super Admin only, body `{ "maxPages": 1..10 }`) repeatedly until the coverage state is `COMPLETE`. Each call is audited on the coverage record.

## Not included (requires Owner and accounting decisions)

- Assigning or attributing unverified payouts. They stay `NOT_VERIFIED` and keep `evidenceComplete` false.
- Any eligibility, reserve or withdrawable-amount calculation.
- Changes to Stripe webhook subscriptions or Dashboard settings.
