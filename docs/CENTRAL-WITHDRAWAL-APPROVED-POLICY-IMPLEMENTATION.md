# Central Withdrawals — implementation requirements after policy approval

Prepared 8 November 2026. **Specification only; LIVE execution remains denied.** This does not approve a reserve formula, numerical value, approval threshold, release period, tax treatment or deployment. It complements `CENTRAL-WITHDRAWAL-RESERVE-DECISION.md` rather than replacing it.

## Recommended architecture and entry conditions

Use liability-first, per-currency reconciliation and durable reservation over the existing financial domains. Only proven transferable platform-owned funds may enter eligibility. Provider cash is a separate ceiling/input, not evidence of ownership. Unclassified records, incomplete reconciliation, missing policy inputs or uncertainty must produce **eligibility unavailable**, never a guessed zero-liability calculation or a fabricated amount.

Before implementation, obtain the complete A–J decisions: earning/ownership rules, Business/customer obligations, refund/dispute/tax/provider exposure, pending/UNKNOWN and external payouts, currencies/conversion, release conditions, authorizers, second approval and professional/provider confirmation. Bind the implemented policy to an immutable reviewed version. The current source denial cannot be removed by an environment flag or by approving this document.

## Authoritative inputs and scope

1. Bind every evaluation/operation to the platform Stripe account identity, TEST/LIVE mode, currency, integer minor units, provider-designated destination and exact proposed amount. A Business account, Customer payment method or another currency cannot supply a fallback.
2. Reuse `finance-ownership.ts`, existing BookingFinancialTransaction and Business payout records, payment/refund/reversal domains and CentralPayoutOperation. Preserve their established formulas; do not create another financial ledger. Document how each approved liability is represented and how already-posted adjustments avoid double counting.
3. Read the platform provider's available/pending balances and relevant payout evidence separately. Recent-100 history is not a complete reservation/obligation inventory. Reconcile Bookly-created, automatic and Dashboard-created payouts under the approved policy; incomplete external visibility must block eligibility.
4. Define evidence provenance and consistency: provider read time/account/mode, canonical local ledger/obligation revision, policy version and unresolved-operation set. A pre-dispatch provider read cannot be atomic with a MongoDB transaction. Explicitly handle stale/provider-changing data rather than treating it as a locked cash balance.

## Race-safe reservation and dispatch

1. Extend the existing operation lifecycle with durable reservation and evidence references. Keep one canonical request identity, immutable amount/currency/destination/account/mode, existing original provider idempotency key and audit trail. Any schema/index additions require separately approved additive provisioning; production `autoIndex` is off.
2. Establish a transactionally checked financial revision/fence for the relevant account/mode/currency. All local operations that can alter protected eligibility must participate, including competing withdrawals and relevant settlement/refund/dispute/obligation changes. A lock around the withdrawal route alone does not protect against other financial writers.
3. In one MongoDB transaction, validate the current actor and required approvals, canonical revision and approved policy evidence, create/reuse the same request-bound operation, reserve the approved eligible amount and append its audit event. A changed revision requires reevaluation; the loser cannot spend stale eligibility. Preserve existing uniqueness for request/provider identities and dispatch coordination.
4. If policy requires independent approval, bind it to the immutable request and eligibility revision, prevent prohibited self-approval and revalidate role/session/freshness at execution. Changed money, destination or evidence invalidates approval. Do not implement an arbitrary threshold.
5. Commit reservation/dispatch intent before invoking Stripe. Never call Stripe inside a retryable MongoDB transaction callback. Dispatch only with the original immutable parameters/idempotency key and current independent execution authority. A known provider rejection is not a completed payout; a timeout/5xx/uncertain outcome remains reserved and unresolved.
6. Serialize local reservations correctly, but do not claim that a MongoDB fence controls Stripe Dashboard/automatic payouts or incoming provider reversals. Qualify/control those operational paths and recheck provider evidence according to the approved policy. If that cannot establish safe execution, keep the authority denied.

The existing active dispatch slot prevents overlapping unconfirmed dispatch, but is released after provider acceptance. It is not a continuing reserve for pending/in-transit funds. A full eligibility reservation must therefore have its own approved lifecycle in the existing operation/accounting architecture.

## Recovery, release and accounting

- A crash before/after provider submission must resume the original operation. Preserve UNKNOWN outcomes; never start another identity to escape a timeout or missing search result. Invalid/backwards local age must not establish an idempotent resend window.
- Retain the existing bounded resend discipline. Stripe's API-v1 key retention is finite; [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests) documents that a pruned key can create a new operation. After the supported source window, or when age is unproven, use correlated provider evidence/manual review rather than blind resend. This is independent of financial reserve/hold periods.
- Track local reservation versus provider-encumbered cash explicitly so a pending payout is not subtracted twice or released merely because dispatch succeeded. Correlate account/mode/amount/currency/destination/provider ID; reject mismatches and preserve evidence.
- Verified webhook and authorized reconciliation reads update the canonical operation with monotonic/CAS-safe transitions. Permit provider-paid to become provider-failed under the existing contract. Provider acceptance, estimated arrival, elapsed time and browser success are not interchangeable settlement evidence.
- Release/convert reservations only on the approved, reconciled evidence transition. A failure/return must not manufacture cash or ownership before the provider and ledger evidence supports it. Continue protecting outstanding Business/customer obligations. TTL, restarts and a missing provider-list match cannot release reservations.
- Audit policy/evidence versions, actor/approval identity, original operation/provider references, reservation changes and review reasons without bank secrets or credentials. Keep existing Bookly Business manual-settlement accounting distinct from platform cash withdrawal.

## Required focused verification and activation handoff

After the decisions and implementation, test simultaneous withdrawals, stale revisions, concurrent obligation increases, dual-approval invalidation if required, duplicate requests/webhooks, crashes at each commit/dispatch boundary, insufficient/mismatched provider cash, ambiguous submission, expired/unprovable resend age, incomplete provider history, pending-to-failed and paid-to-failed returns, per-currency isolation and reservation non-release. Use mocks first; actual transaction/index/provider qualification requires separate authorization.

Production release then requires approved policy and code review, exact indexes/transaction qualification, real platform account/bank/schedule/provider evidence, accounting reconciliation, all-instance compatibility, authorized rollback/monitoring and a separately approved authority release. Rollback denies new withdrawals while preserving reservation records, provider references and reconciliation. No paid queue, new ledger or paid monitoring dependency is required by this specification. Existing provider fees and hosting costs remain real operating costs.
