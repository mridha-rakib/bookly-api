# Stripe payout observations, status verification and history coverage (FG03B-1/2/3)

Status: **source only. Not provisioned, not enabled, no backfill run, no worker running.** LIVE central withdrawals are still denied in source, and nothing here changes that.

## What this adds

- **`stripepayoutobservations`**: one non-monetary record per Stripe payout per mode (TEST or LIVE). Each record is bound to the Stripe platform account (`acct_…`) that reported it.
  - Records come from verified `payout.*` webhooks and from full history reads.
  - The account is the one that owns the configured secret key. Stripe itself reports it (`accounts.retrieveCurrent`), and it is read once per key per process. It is never taken from payload metadata.
  - Each record carries a linkage:
    - `VERIFIED_BOOKLY`: a withdrawal operation records this exact payout id in the same mode.
    - `UNRESOLVED`: the metadata names an unconfirmed Bookly operation.
    - `NOT_VERIFIED`: anything else.
  - Each record also stores:
    - Stripe's latest reported status (`status`);
    - when Stripe last confirmed it (`lastObservedAt`, from a webhook or a list read);
    - when a full read last listed it (`lastListedAt`);
    - any contradiction from Stripe's list (`listedStatusConflict`).
  - A record is not a ledger entry, not a withdrawal operation, and not proof of ownership, authorization, bank receipt or finality.
  - Stored data is minimal: no metadata payload, no bank numbers, and no provider failure text. The bank is kept only as Stripe's reference plus a masked last 4.
- **`stripepayouthistorycoverages`**: one checkpoint per mode for the bounded, resumable full history read. It holds:
  - the Stripe account id the coverage belongs to (coverage resets when the account changes);
  - the cursor of the read in progress;
  - `completeAsOf`;
  - the last error;
  - a lease, so only one read proceeds at a time;
  - a capped audit trail recording whether each run was started by an operator or by the worker.
- **Webhooks**: `payout.*` events are recorded for the current platform account.
  - Connected-account events and events from the other mode are skipped.
  - If the platform account cannot be read, the event fails and stays retryable, so nothing is recorded without an account.
  - No withdrawal operation is ever created for an external payout.
- **Readiness**: `GET /super-admin/finance/withdrawals/overview` includes `reconciliation`. It is built from database reads only and is never a permission.
- **Review**: `GET /super-admin/finance/withdrawals/provider-payouts`. It is Super Admin only, read-only, database-only, masked, filtered and paginated (limit at most 50).
  - Each row carries the provider lifecycle, its `statusVerification` and its `reviewReasons`.
  - There are no assignment, override, deletion or adjustment actions.

## Status finality (FG03B-3)

Stripe's Payout object reference states:

> "The status changes to `paid` if the transaction succeeds, or to `failed` or `canceled` (within 5 business days). Some payouts that fail might initially show as `paid`, then change to `failed`."

It also describes `arrival_date` only as when the payout can be *expected* to arrive.

Stripe documents **no time limit** for `paid → failed`. Bookly therefore:

- applies **no finality window** (the FG03B-2 10-day assumption is removed) and never treats a `paid` payout as final because of its age;
- treats `paid` as Stripe's report, never as bank-confirmed receipt;
- keeps accepting `paid → failed` from webhooks and list reads at any age;
- re-reads **every** payout, of any age and status, on every full history read;
- reports financial finality as **not established** (`finality.code = BANK_SETTLEMENT_NOT_VERIFIED`), because Bookly holds no bank-statement evidence. This is the precise blocker: only an approved bank-statement reconciliation source could support finality.

`failed` and `canceled` are Stripe's documented end states (no transition out of them is documented). They are labelled "ended" and are not counted as stale, but they are still re-read on every full read.

## Status verification and coverage

- **Every run is a FULL re-read** of the account's payout list: newest first, no date window, cursor pagination, at most 10 pages of 100 per call.
  - A run completes only when Stripe returns `has_more: false`, and `completeAsOf` is the run's start time.
  - Completion proves that every payout Stripe listed had its status re-read at or after `completeAsOf`.
  - It is reported as `freshness.statusVerifiedAsOf`, but only when the coverage belongs to the current account.
- Any of the following stops a run without completing it:
  - a provider error or rate limit;
  - a mode mismatch;
  - an empty page that claims more results;
  - a repeated cursor;
  - a page not in newest-first order;
  - an account conflict;
  - a lost lease.

  The cursor is checkpointed only while the lease is held, so the next call resumes from the same position and nothing is skipped. While a re-verification is in progress, a previously completed read stays valid as of its own `completeAsOf`, and the failure is reported as a blocker.
- **Per-payout status verification** (review rows):
  - `CURRENT`.
  - `STALE`: not ended, and not re-confirmed by Stripe within the freshness target.
  - `NOT_RECONFIRMED`: created more than 10 minutes before the last complete read, but not listed by it. Stripe should have returned it, so its current status is unverified.
  - `CONFLICT`: Stripe's current list reports a lifecycle-earlier status than the recorded one, for example `paid` after a recorded `failed`. The recorded status is kept, and the conflict clears when a later list read agrees.
- **Readiness fails closed.** `evidenceComplete` is false while any of these blockers applies:

  | Blocker | Condition |
  | --- | --- |
  | `PROVIDER_ACCOUNT_UNVERIFIED` | The current Stripe account cannot be identified |
  | `PROVIDER_ACCOUNT_CHANGED` | The account differs from the one the history was read from |
  | `HISTORY_NEVER_SYNCED` | No full read has ever been attempted |
  | `HISTORY_INCOMPLETE` | The first full read has not reached Stripe's last page |
  | `HISTORY_SYNC_FAILED` | The last read stopped with an error |
  | `STATUS_VERIFICATION_STALE` | The last complete full read is older than the freshness target |
  | `PAYOUTS_NOT_RECONFIRMED` | Recorded payouts were not listed by the last complete read |
  | `PROVIDER_STATUS_CONFLICT` | Stripe's list contradicts a recorded status |
  | `OBSERVATIONS_STALE` | Payouts Stripe can still change have not been re-confirmed recently |
  | `UNVERIFIED_PAYOUTS_PRESENT` | Payouts are not linked to a Bookly withdrawal |
  | `UNRESOLVED_LINKAGE_PRESENT` | Payouts name a Bookly withdrawal that has not confirmed them |
  | `WITHDRAWALS_AWAITING_CONFIRMATION` | Bookly withdrawals are still awaiting Stripe confirmation |
  | `PAYOUTS_IN_FLIGHT` | Payouts are still pending or in transit |

  Even with no blockers, `evidenceComplete` means complete, current **provider** evidence only. It is not finality, not eligibility and not permission to withdraw.
- The **freshness target is 24 hours**. It is an operational evidence-refresh target, not a finality guarantee.

## Operational readiness (prerequisites for dependable evidence)

1. **Webhook subscription.** In the Stripe Dashboard, the operator must verify that the Bookly endpoint for each mode subscribes to `payout.created`, `payout.updated`, `payout.paid`, `payout.failed` and `payout.canceled`. Bookly does not change subscriptions.
2. **Webhook delivery and failed-event recovery.**
   - Stripe retries undelivered events according to its webhook retry policy.
   - Bookly stores each event before processing it. A failed payout event, for example because the platform account was unreadable, is marked retryable and re-processed by the existing money-recovery worker (`recoverDue`), if that worker is enabled.
   - Monitor events stuck in a failed state.
   - Events that Stripe never delivered are caught only by the next full read. That is why readiness depends on freshness.
3. **Historical read.** A full read is required:
   - initially;
   - after any Stripe account change;
   - at least once per freshness target.

   An operator triggers one with the Super Admin action "Read Stripe payout history". It is gated by `CENTRAL_PAYOUT_HISTORY_SYNC_ENABLED`, and the operator repeats it until the state is `COMPLETE`.
4. **Optional refresh worker (`pnpm worker:payout-evidence`, or `:once`).**
   - It is disabled unless both `BOOKLY_PAYOUT_EVIDENCE_WORKER_ENABLED=true` and `CENTRAL_PAYOUT_HISTORY_SYNC_ENABLED=true` are set.
   - It is not wired into any process manager. Enabling it needs separate approval.
   - Each pass makes at most 5 calls of 10 pages (5,000 payouts). The interval defaults to 6h and must be between 15 minutes and 24 hours (`BOOKLY_PAYOUT_EVIDENCE_INTERVAL_MS`).
   - It uses the same lease, so it is safe alongside an operator read. It skips a pass while another read holds the lease.
   - Anything short of a completed full read is logged as incomplete, never as success.
5. **Provider limits and retries.**
   - Every call is bounded. A Stripe rate limit or 5xx ends the call as `PROVIDER_ERROR` with the checkpoint kept; retry later.
   - Dashboard loads never call Stripe's payout list beyond the existing recent-100 sample. The review is database-only.
   - Accounts with very large payout histories need more calls per full read. Monitor `runInProgress`.
6. **Account identity.**
   - After any key or account change, expect `PROVIDER_ACCOUNT_CHANGED` until a full read of the new account completes.
   - If the identity is unreadable (`PROVIDER_ACCOUNT_UNVERIFIED`, or 409 on the review), check the key's permissions.
7. **Freshness monitoring.** Alert on any of the following, read from the overview or from worker logs (`CENTRAL_PAYOUT_EVIDENCE_PASS`):
   - `STATUS_VERIFICATION_STALE`;
   - `HISTORY_SYNC_FAILED`;
   - `PAYOUTS_NOT_RECONFIRMED`;
   - `PROVIDER_STATUS_CONFLICT`.
8. **Recovery when a read is incomplete.** Re-run the read: it resumes from the checkpoint.
   - A lease left by a crashed run expires after 2 minutes.
   - A persistent `PROVIDER_STATUS_CONFLICT` or `PAYOUTS_NOT_RECONFIRMED` needs manual investigation in the Stripe Dashboard. Bookly never resolves it automatically.

## Additive provisioning required before enabling (production `autoIndex` is off)

FG03B-3 adds no index. `lastListedAt` and `listedStatusConflict` are read only within the account-scoped index ranges below.

| Collection | Index | Options |
| --- | --- | --- |
| `stripepayoutobservations` | `{ mode: 1, providerPayoutId: 1 }` | `unique: true` |
| `stripepayoutobservations` | `{ accountId: 1, mode: 1, providerCreatedAt: -1 }` | |
| `stripepayoutobservations` | `{ accountId: 1, mode: 1, linkage: 1, providerCreatedAt: -1 }` | |
| `stripepayoutobservations` | `{ accountId: 1, mode: 1, status: 1, providerCreatedAt: -1 }` | |
| `stripepayouthistorycoverages` | `{ mode: 1 }` | `unique: true` |

Do **not** create the FG03B-1 `{ mode: 1, linkage: 1 }` or `{ mode: 1, status: 1 }` indexes.

Create these with an approved targeted index operation, not a broad sync of every model. **Create the unique observation index before deploying**, because webhook observations start being written as soon as the new API is deployed. No data migration is needed: both collections are empty in every shared environment.

## Not included (requires Owner, Stripe and accounting decisions)

- Financial finality or bank-statement reconciliation (no approved bank evidence source).
- Assigning or attributing unverified payouts.
- Tracking payout reversals (`reversed_by` / `original_payout`). A reversal payout is observed as its own record, but the two are not linked.
- Any eligibility, reserve or withdrawable-amount calculation.
- Changes to Stripe webhook subscriptions or Dashboard settings.
