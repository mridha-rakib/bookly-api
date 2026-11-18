# Central withdrawal eligibility — policy CW-1

Status: **implemented in source and verified with mocked Stripe and isolated test databases.** Not deployed. LIVE execution is off unless the deployment sets `CENTRAL_PAYOUTS_LIVE_ENABLED=true`, which needs a separately authorized release.

This implements the reserve decision in `CENTRAL-WITHDRAWAL-RESERVE-DECISION.md`, using the Owner-confirmed rules below. It reuses the existing ledger and ownership rules (`finance-ownership.ts`), the refund, dispute, package and booking records, the payout evidence (FG03B-1/2/3), and the `CentralPayoutOperation` lifecycle. No new ledger exists, and no money is moved between owners.

## Owner-confirmed rules

- **Bookly revenue:** Bookly earns only `PLATFORM_FEE`, net of its own processing fees, refunds, disputes and promo subsidies.
- **Business-owned money:** `DEPOSIT`, `CANCELLATION_FEE`, `NO_SHOW_FEE` and `PROMO_SUBSIDY` belong to the Business. They are never Bookly revenue.
- **Withdrawals:** only a Super Admin withdraws from Stripe to the company bank, through Stripe Payouts.
- **Business settlement:** Business-owned money may move to the company bank as part of this workflow. The Super Admin pays each Business manually outside Bookly, and Bookly records that transfer (`BusinessPayout`).
- **The liability stays recorded.** Until a transfer is recorded, the Business liability remains on the books. A central withdrawal never changes owner figures, Business payables or settlement records. It changes only where the cash sits.

## Eligibility (per currency)

```
ledgerHeld = Stripe-charged ledger inflows − ledger outflows − Stripe payouts out of this account
eligible   = min(Stripe available, ledgerHeld) − protected        (UNAVAILABLE → 0)
```

| Input | Source | Notes |
| --- | --- | --- |
| Stripe available | `balance.retrieve()` | Pending funds are never counted. |
| Stripe-charged inflows | SUCCEEDED `PLATFORM_FEE`, `DEPOSIT`, `CANCELLATION_FEE`, `NO_SHOW_FEE`, `TAX_LIABILITY` rows that carry a Stripe PaymentIntent or charge reference, plus `DISPUTE_REINSTATEMENT` and `DISPUTE_FEE_REVERSAL` | Payments made directly to a Business, and rows with no Stripe reference, are never counted as Stripe cash. `PROMO_SUBSIDY` is not cash. |
| Outflows | SUCCEEDED `REFUND`, `TAX_REVERSAL`, `PROCESSING_FEE`, `DISPUTE_WITHDRAWAL` and `DISPUTE_FEE` | Counted whatever their reference, which errs toward withdrawing less. |
| Stripe payouts out | Every observed payout of this account and mode that has not failed or been canceled (Bookly, Dashboard or automatic), plus Bookly payouts Stripe accepted but that have not been observed yet. Each is counted once. | Requires complete, current payout evidence. |
| Protected: refunds in progress | `RefundOperation` in `CREATED`, `PROVIDER_PENDING` or `RECONCILIATION_REQUIRED` | The expected refund amount. |
| Protected: refundable bookings | `UPCOMING` and `PENDING` bookings: the full net Stripe-charged upfront amount (the contractual maximum refund). Cancelled bookings whose `refundOwedCents` is still unsettled: that amount. | Bookings already covered by a refund in progress are not counted twice. |
| Protected: refundable packages | An active package (not voided, sessions remaining): the net upfront charge on its origin booking. A void refund still pending or failed: its amount. | |
| Protected: disputes | Any dispute that is not final and not yet debited, or not correlated to a ledger row. Final non-lost disputes are excluded. | |

The minimum of the two caps keeps eligibility within real Stripe cash, and also away from cash the ledger cannot attribute. No percentage, buffer or time window is used.

## Fails closed (UNAVAILABLE, amount 0)

A currency is UNAVAILABLE when any of the following applies:

- Stripe is not configured, the balance is in the wrong mode, or the account cannot be identified.
- Payout evidence is incomplete or untrustworthy:
  - the history has never been read, is incomplete, or the last read failed;
  - the status verification or the observations are stale;
  - payouts were not reconfirmed, or Stripe's list contradicts a recorded status;
  - a payout's linkage is unresolved;
  - a previous withdrawal is still unconfirmed.
- Stripe processing fees are not yet confirmed.
- Stripe payouts exceed the cash the ledger attributes to the account (`LEDGER_PROVIDER_MISMATCH`).
- The currency is one Bookly never charges in.

External (unverified) and in-flight payouts are **not** blockers. They are counted as cash already out of Stripe.

## Reservation and execution safety

1. **Review.** `GET /super-admin/finance/withdrawals/eligibility` returns the decision and a SHA-256 `digest` of every input.
2. **Confirmation.** `POST /super-admin/finance/withdrawals` requires all of the following, in this order:
   - a Super Admin;
   - the current password;
   - the exact digest that was reviewed (`CENTRAL_PAYOUT_ELIGIBILITY_CHANGED` otherwise);
   - an eligible currency (`CENTRAL_PAYOUT_ELIGIBILITY_UNAVAILABLE` otherwise);
   - an amount no greater than the eligible amount (`CENTRAL_PAYOUT_EXCEEDS_ELIGIBLE` otherwise);
   - no account or execution restriction (manual schedule, payouts enabled, a valid default destination, matching mode, and the LIVE flag for LIVE).
3. **Reservation.** The operation is created with an immutable amount, currency, destination, idempotency key and eligibility snapshot. The unique `activeSlot` admits one unresolved withdrawal at a time, so two requests can never spend the same eligibility.
4. **Pre-dispatch revalidation.** After the reservation is committed and outside any transaction, eligibility is re-evaluated with this operation excluded:
   - *Not covered, first send:* the operation is closed as REJECTED, never sent, and `RESERVATION_RELEASED` is audited.
   - *Not covered, recovery resend:* `REQUIRES_REVIEW` is audited and the resend does not happen.
   - *Unreadable:* the request is not sent.

   Stripe is never called inside a MongoDB transaction.
5. **Lifecycle.** An accepted, pending, in-transit or paid payout stays counted as out of Stripe. Only a Stripe-reported `failed` or `canceled`, a definitive provider rejection, or a never-sent rejection releases it, each audited as `RESERVATION_RELEASED`. Existing recovery is unchanged: UNKNOWN handling, the original idempotency key and the bounded resend window.

**Why liability changes don't break the reservation.** Most liability changes are eligibility-neutral by construction:
- a cancellation refund moves from refundable exposure, to refund in progress, to an outflow;
- a new paid booking adds equal cash and exposure;
- Stripe debits a dispute when it is created.

**Residual risk (documented, not hidden).** Eligibility does not protect two things:
- a discretionary refund of an already completed booking;
- a Stripe-side debit with no ledger record.

Stripe still refuses a payout above its available balance.

## LIVE gate

LIVE requires all of the following:

- the deployment flag;
- a LIVE key whose balance is LIVE;
- an identified account with payouts enabled and a manual payout schedule;
- a valid default destination;
- AVAILABLE eligibility at both confirmation and dispatch;
- the step-up password.

The former hard-coded `CENTRAL_PAYOUT_RESERVE_POLICY_UNAPPROVED` denial is replaced by these controls.

**External confirmation (category J) is not something code can verify:** Stripe's written confirmation of the custodial model, Cyprus legal advice and accountant sign-off. Keep `CENTRAL_PAYOUTS_LIVE_ENABLED=false` until they are obtained and a release is authorized.

## Stripe TEST default destination (TEST only)

Stripe refuses a TEST key the platform bank-account list with "Only live keys can access this
method". Without a fallback every TEST withdrawal failed with `CENTRAL_PAYOUT_DESTINATION_UNREADABLE`.

- The Stripe adapter reports `destinationReadIssue: "TEST_MODE_RESTRICTED"` only for that exact
  message, only with an `sk_test_`/`rk_test_` key, and only before any bank page was read. Every
  other failure keeps its existing classification.
- The overview then offers `stripeTestDefaultDestination` (marker `stripe_test_default`, label
  "Stripe TEST default destination — bank details unavailable in TEST mode."). No `ba_…` id or
  bank detail is invented; the operation stores the marker, an empty last 4 and the TEST
  account it was confirmed against (`testDefaultAccountId`).
- The payout is created without `destination`, so Stripe uses the TEST account's default
  external account for the currency, or refuses. A refusal is recorded as REJECTED with
  Stripe's own message, and the reservation is released.
- The marker is refused for a LIVE key, LIVE balance, unidentified account, readable bank list
  or another read failure. At dispatch it is refused if the mode, account or bank-list state
  changed, and then it is never sent. The adapter itself refuses the marker for any non-TEST key
  before calling Stripe. Step-up, digest, eligibility, idempotency, the active slot and the audit
  are unchanged.
- A TEST payout is simulated by Stripe; it is never a bank-confirmed transfer.
- LIVE destination verification is unchanged (a verified, unique default `ba_…` is required).

## Indexes (additive; production `autoIndex` is off)

| Collection | Index |
| --- | --- |
| `bookings` | `{ status: 1 }` |
| `packageprogresses` | `{ remainingSessions: 1 }`, `{ "voidRefundSettlement.status": 1 }` (sparse) |
| `paymentdisputes` | `{ correlation: 1 }` |

Plus the FG03B indexes in `CENTRAL-PAYOUT-OBSERVATIONS.md`. No migration is needed: `eligibility` on `centralpayoutoperations` is an optional new field.

## Known limits

- The ledger has no TEST/LIVE marker. Each environment's database must hold only its own mode's data, which is the existing deployment model.
- The eligibility read aggregates the whole ledger on each review, confirmation and dispatch. That is acceptable at current volume; monitor its latency.
