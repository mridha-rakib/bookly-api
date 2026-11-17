# Stripe payout observations and history coverage (FG03B-1, hardened in FG03B-2)

Status: **source only. Not provisioned, not enabled, no backfill run.** LIVE central withdrawals are still denied in source, and nothing here changes that.

## What this adds

- **`stripepayoutobservations`**: one non-monetary record per Stripe payout per mode (TEST or LIVE). Each record is bound to the Stripe platform account (`acct_…`) that reported it.
  - Records come from verified `payout.*` webhooks and from the history read.
  - The account is the one that owns the configured secret key. Stripe itself reports it (`accounts.retrieveCurrent`), and it is read once per key per process. It is never taken from payload metadata.
  - Each record carries a linkage:
    - `VERIFIED_BOOKLY`: a withdrawal operation records this exact payout id in the same mode.
    - `UNRESOLVED`: the metadata names an unconfirmed Bookly operation.
    - `NOT_VERIFIED`: anything else.
  - A record is not a ledger entry, not a withdrawal operation, and not proof of ownership, authorization or bank receipt.
  - Stored data is minimal: no metadata payload, no bank numbers, and no provider failure text. The bank is kept only as Stripe's reference plus a masked last 4 when the account's bank list names it.
- **`stripepayouthistorycoverages`**: one checkpoint per mode for the bounded, resumable history read. It holds:
  - the Stripe account id the coverage belongs to (coverage resets when the account changes);
  - the cursor and window start of the run in progress;
  - `completeAsOf`;
  - the last error;
  - a lease, so only one run proceeds at a time;
  - a capped audit trail.
- **Webhooks**: `payout.*` events are recorded as observations of the current platform account.
  - Events carrying a connected-account `account` are skipped, because they are not platform payouts.
  - Events whose mode differs from the configured key are skipped, because their account cannot be verified.
  - If the platform account cannot be read, the event fails and stays retryable, so nothing is recorded without an account.
  - Event deduplication, the signature check and the operation status rules are unchanged. No withdrawal operation is ever created for an external payout.
- **Readiness**: `GET /super-admin/finance/withdrawals/overview` includes `reconciliation`. It is built from database reads only and is never a permission.
- **Review**: `GET /super-admin/finance/withdrawals/provider-payouts`. It is Super Admin only, read-only and served from the database (it never lists payouts from Stripe).
  - Filters: `mode`, `linkage`, `status`, `needsReview`, `from`/`to` (UTC Stripe creation days), and `page`/`limit` (limit at most 50).
  - Results are always scoped to the current verified account. The request is refused with 409 `CENTRAL_PAYOUT_ACCOUNT_UNIDENTIFIED` if that account cannot be identified.
  - Each row carries `settlement`, `stale` and `reviewReasons`. The response states coverage, staleness and how many observations of other accounts are excluded.
  - There are no assignment, override, deletion or adjustment actions.

## Account isolation

- Observations stay unique on `{ mode, providerPayoutId }`, because Stripe payout ids are globally unique. A payout already recorded under one account is never rewritten under another.
  - In a webhook, a conflicting payout is logged as `CENTRAL_PAYOUT_OBSERVATION_ACCOUNT_CONFLICT` and left untouched.
  - In a history read, it stops the run before the checkpoint moves.
- Every count and review query filters on `{ accountId, mode }` of the current account. Observations of a previously configured account are retained, reported only as `otherAccounts`, and never counted as evidence.
- If the current account cannot be identified, readiness counts nothing and reports `PROVIDER_ACCOUNT_UNVERIFIED`, and the review refuses to answer.

## Coverage and freshness

- A history run reads Stripe's payout list newest first with cursor pagination, at most 10 pages of 100 per request.
- It is marked `COMPLETE` only when Stripe returns `has_more: false`.
- Any of the following leaves the coverage `IN_PROGRESS`:
  - a provider error;
  - a mode mismatch;
  - an empty page that claims more results;
  - a repeated cursor;
  - a payout outside the requested window;
  - an account conflict;
  - a lost lease.

  The pages already read stay recorded, and the next request resumes from the saved cursor. Checkpoints are written only while the lease is held, so a run that lost its lease cannot move the cursor.
- **Window of a new run after a completed one.** The run starts from the earlier of:
  - the previous completion time minus 24 hours;
  - the creation time of the oldest still-unsettled observation of this account.

  This means a missed webhook for an older in-flight or recently paid payout is re-read from Stripe rather than left stale.
- **Unsettled** means one of:
  - `pending` or `in_transit` (or an unknown status);
  - `paid` with an arrival date (or, if Stripe gave none, a creation date) within the last **10 days**.

  The 10 days is an engineering assumption, not a Stripe guarantee. Stripe can report a paid payout as failed, and this window needs Stripe/accountant confirmation.
- **Stale** means unsettled and not re-confirmed by Stripe for **24 hours**.
- Readiness blocks on each of the following:

  | Blocker | Condition |
  | --- | --- |
  | `OBSERVATIONS_STALE` | Unsettled payouts not re-confirmed for 24 hours |
  | `HISTORY_STALE` | The last complete read is more than 24 hours old |
  | `PAYOUTS_IN_FLIGHT` | Payouts still pending or in transit |
  | `PAYOUTS_WITHIN_FAILURE_WINDOW` | Payouts paid within the failure window |
  | `UNVERIFIED_PAYOUTS_PRESENT` | Payouts not linked to a Bookly withdrawal |
  | `UNRESOLVED_LINKAGE_PRESENT` | Payouts naming a Bookly withdrawal that has not confirmed them |
  | `WITHDRAWALS_AWAITING_CONFIRMATION` | Bookly withdrawals still awaiting Stripe confirmation |

  Readiness also blocks on any coverage or account problem.
- **Known limit:** a status change to a `paid` payout older than the window can only arrive by webhook. No list read revisits it, so a missed webhook there goes undetected.

## Linkage consistency

- When a withdrawal operation records a Stripe payout id, the matching observation is promoted to `VERIFIED_BOOKLY`, whichever path confirmed it: Stripe's response, recovery, refresh or a webhook.
- After every observation write, the observation is also checked against operations again, which closes the race in both orders.
- A verified link is never downgraded. Metadata alone never verifies a payout.

## Additive provisioning required before enabling (production `autoIndex` is off)

FG03B-1 was never provisioned, so the FG03B-1 `{ mode: 1, linkage: 1 }` and `{ mode: 1, status: 1 }` indexes are **not** to be created. Create only the indexes below:

| Collection | Index | Options |
| --- | --- | --- |
| `stripepayoutobservations` | `{ mode: 1, providerPayoutId: 1 }` | `unique: true` |
| `stripepayoutobservations` | `{ accountId: 1, mode: 1, providerCreatedAt: -1 }` | |
| `stripepayoutobservations` | `{ accountId: 1, mode: 1, linkage: 1, providerCreatedAt: -1 }` | |
| `stripepayoutobservations` | `{ accountId: 1, mode: 1, status: 1, providerCreatedAt: -1 }` | |
| `stripepayouthistorycoverages` | `{ mode: 1 }` | `unique: true` |

Create these with an approved targeted index operation, not a broad sync of every model. Webhook observations start being written as soon as the new API is deployed, so **create the unique observation index before deploying**. Without it, concurrent first deliveries could create duplicate observation records or bypass the account-conflict check (no money is affected).

No data migration is needed: both collections are empty in every shared environment, because nothing was deployed. If a local development database holds FG03B-1 records without `accountId`, they are never counted and are never rewritten. Drop that local collection rather than migrating it.

## Enabling the history read

The history read stays disabled until all of the following are true:

1. The indexes above exist on the target database.
2. The API release containing this change has been deployed through the normal approved procedure.
3. The Owner approves running the read.

Only then set `CENTRAL_PAYOUT_HISTORY_SYNC_ENABLED=true`.

The operator then calls `POST /super-admin/finance/withdrawals/provider-history/sync` (Super Admin only, body `{ "maxPages": 1..10 }`) repeatedly until the coverage state is `COMPLETE`. Each call is audited on the coverage record. Keeping evidence fresh needs another read at least once every 24 hours. No scheduler exists: each read is triggered by an operator.

## Not included (requires Owner and accounting decisions)

- Assigning or attributing unverified payouts. They stay `NOT_VERIFIED` and keep `evidenceComplete` false.
- Any eligibility, reserve or withdrawable-amount calculation.
- Confirmation of the 10-day paid→failed assumption.
- Changes to Stripe webhook subscriptions or Dashboard settings.
