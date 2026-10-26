# Ordinary Booking 3DS and webhook deployment contract

26 October 2026. Source-supported contract; runtime verification and activation NOT DONE.

## Booking confirmation authority

The Customer Venue wizard previews its current request and submits the existing authenticated
Booking finalize endpoint. The server may return `requires_action` with a client secret, or a
persisted Booking detail. Those are distinct outcomes. Stripe.js `confirmCardPayment` completes
the existing challenge; the Client must then submit the **same input and idempotency key** to
the same finalize endpoint. Only its Booking result may open confirmation. A challenge result,
redirect query string, elapsed timeout or webhook acknowledgement is not a confirmed Booking.

The current browser integration uses the existing Stripe.js challenge call, not a new hosted
checkout flow. A failed/abandoned challenge, unavailable Stripe.js, repeated requires_action or
unknown result remains unconfirmed. Ambiguous errors keep the logical key for authoritative retry.
New account/session or closed-wizard continuations must not dispatch the old challenge retry or
show its private result. Closing the UI is not cancellation/refund of a server operation.

The wizard is in-memory. Reload/navigation loses its request identity; there is no Customer-owned
orphan-attempt/status-resume read endpoint in the current contract. Do not restore success from
`redirect_status=succeeded`, expose provider IDs as ownership proof, persist client secrets in
browser storage or silently create a replacement paid operation. Existing same-key replay works
when the caller still has the original input/key. Persisted bookings are available through owned
history/detail; orphan uncertainty is handled by existing guarded recovery/compensation. Complete
reload-resume UX needs a separately scoped identity/storage/read contract, not an invented callback.

Ordinary preview is not a financial command; finalization/replay derive or validate their existing
server-owned terms and admission. Do not replace those rules with a cached Client quote or change
quote/consent expiry policy. First-class Package activation stays denied by its existing authority.

## Existing webhook endpoint and configuration

External path: `/api/{API_VERSION}/payments/webhooks/stripe` (default version is defined in env.ts).
Use the actual approved API origin/version on the target. The route is public for signed provider
requests; it is not a Customer/admin financial mutation. No production endpoint was configured here.

- Configure server-side `STRIPE_SECRET_KEY` and the endpoint's matching `STRIPE_WEBHOOK_SECRET`
  using the trusted target's secret mechanism. Shared production env validation also applies.
- Browser Stripe.js uses only `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`; it must belong to the intended
  approved provider environment/account. The backend's `STRIPE_PUBLISHABLE_KEY` setting alone does
  not configure the separately built browser bundle. Never expose signing/server secrets there.
- Keep synthetic test and live configuration separate. Do not contact either provider environment
  without target-specific authorization. Placeholder-looking keys do not establish a safe sandbox.
- Preserve incoming JSON bytes and `stripe-signature` through the reverse proxy. The application
  mounts the webhook before global express.json; the route uses express.raw with a 1mb limit.
  Parsing/re-encoding before signature verification breaks the existing boundary.
- Verify the target route, signing secret and synthetic delivery through the approved ingress. No
  provider subscriptions, signing-key rotation, proxy/deployment change or replay ran in this task.

Handled event types in the current service:

```text
payment_intent.succeeded
payment_intent.payment_failed
payment_intent.canceled
setup_intent.succeeded
charge.refunded
charge.refund.updated
charge.dispute.created
charge.dispute.updated
charge.dispute.closed
charge.dispute.funds_withdrawn
charge.dispute.funds_reinstated
```

`setup_intent.succeeded` is informational; it does not create a Booking. Unsupported event types
are acknowledged without financial dispatch. Keep event delivery subscriptions aligned with
these source handlers; adding event types/provider behavior requires its own reviewed source.

## Acknowledgement, durable processing and replay

The gateway verifies the exact Buffer with the configured signing secret. Missing/invalid signature
or a non-Buffer body is rejected; missing provider configuration fails closed. Verification is
before processing. A valid delivery is recorded/claimed using its event ID; the model has a unique
eventId index and due/lease query indexes. Verify existing indexes through an authorized target
workflow; this task adds no index or migration.

The controller returns 200 for processed, ignored or not-currently-claimable events. This means
receipt/dispatch handling, not that all financial accounting is complete. A thrown processing error
returns a generic 500 and retains durable retry handling; terminal investigation handling can end
without a thrown error and still acknowledge 200. Do not interpret either response as Customer
bank settlement or guaranteed booking persistence.

Existing event claims use a 60-second lease/token. Due RECEIVED/RETRYABLE/expired PROCESSING records
can be claimed; completion/failure updates require the same owner token. Retry backoff begins at
30 seconds and is capped at 15 minutes, with the existing retry budget of eight before terminal
failure. Terminal PROCESSED/FAILED duplicates do not replay automatically. Domain writes use their
existing source identities, correlation and terminal guards independently of event deduplication.

An early succeeded event with no matching source ledger remains retryable; it does not manufacture
a Booking or ledger principal. Existing Package authority, terminal conflicts and investigation
rules remain unchanged. Out-of-order provider observations must obey their original state guards.

The existing Super Admin-only replay route is
`/api/{API_VERSION}/super-admin/finance/webhook-events/:eventId/replay`. It requires the existing
active Super Admin authentication/role gate, a stored FAILED event/payload and an atomic reset/
fresh claim. It records replay actor/count and uses the same processor. HTTP success can report
RETRYABLE or FAILED as well as PROCESSED; replay is not a payout or completion guarantee. There
is no new Customer replay action or arbitrary Client-supplied event dispatch endpoint.

## Recovery and operational prerequisites

F3A builds StripeWebhookService with the existing composition dependencies, and
MoneyRecoveryService invokes recoverDue plus its existing payment/refund/relationship/reversal
passes. Delayed/lost deliveries and expired worker leases require durable recovery and real
runtime verification, not an assumption of guaranteed provider delivery. The F3A PM2 process remains
separately opt-in with an operator-confirmed one-consumer topology; its flag is not a distributed
lease. Do not start another worker or enable activation while deploying webhook configuration.

Before release, run real signature/HTTP, lease/replay/ordering/concurrency and provider-success/
persistence-interruption tests on an independently trusted host with reviewed source and disposable
synthetic targets. Verify persisted attempts, Booking/reservations, source ledger, refund operations,
Customer financialOutcome and log privacy. Local signature fixtures and mocked Stripe.js are not
provider test-mode 3DS observations. Test-provider observations are not bank-arrival proof. All such
execution remains NOT RUN here.
