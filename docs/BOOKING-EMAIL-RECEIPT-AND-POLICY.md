# Booking confirmation: payment receipt and policy disclosure (F4A Tier 3)

27 October 2026. **NOT VERIFIED.**

## Payment receipt section

The customer confirmation (`BOOKING_CUSTOMER_CONFIRMED`, and `BOOKING_FOR_CLIENT_CONFIRMED`)
contains a **Payment receipt** section only when Bookly holds verified collection evidence,
written in the same Booking transaction:

- the ledger row recorded by that transaction (`status SUCCEEDED`, `direction DEBIT`,
  `providerReference`), and
- the PaymentAttempt (`providerStatus SUCCEEDED`, `providerSucceededAt`,
  `providerPaymentIntentId`, `expectedAmountCents`, `currency`),

and the two agree on reference, amount and currency. Charges use automatic capture, and
persistence starts only after the provider reports `succeeded`, so this is collected money,
not an authorization.

Shown: amount paid, paid on (provider success time, business timezone), what it paid for
(booking / package purchase / add-ons and fees for a package session), the payment reference
(Stripe PaymentIntent id) and the booking reference.

Not shown, because Bookly does not record it: VAT/tax (Cyprus VAT is computed but never added
to the charge), card details, processing fees, a receipt number. The confirmation states that
the receipt covers only the amount paid online.

| State | Confirmation shows |
|---|---|
| Verified payment | "Paid online: €X" + receipt section |
| No PaymentIntent (zero online charge, MANUAL, package session without extras) | "Paid online: Nothing — no upfront payment was taken" |
| Evidence incomplete | no paid-online line, no receipt (logged `BOOKING_CREATED_PAYMENT_UNVERIFIED`) |
| Legacy callers (no evidence supplied) | the previous "Paid online now" line, unchanged |

Pending, failed, 3DS-only and uncertain payments never reach Booking persistence, so they
never produce a confirmation or receipt. Compensation refunds are not described here.

## Policy disclosure

From the Booking's own `cancellationPolicySnapshot` (never the live business policy):

- the five fixed windows before the start time (≥72 h, 72–24 h, 24–12 h, 12–2 h, <2 h), each
  with its deadline in the business timezone and its fee ("No fee" or "N% of €basis", where
  basis = services + add-ons − discount, excluding travel). Windows that had already ended
  when the Booking was created are omitted;
- the no-show fee (snapshot percentage of the same basis);
- for package-linked Bookings: a late cancellation or no-show forfeits the session, no fee;
- a note that any amount already paid online counts towards the fee.

These mirror `buildCancellationOutcome` and `computeNoShowPenalty`. Without a snapshot:
"No cancellation or no-show fee applies to this booking" (what both functions compute).
No public policy URL is linked: no stable, versioned public route for a Booking's agreed
policy exists, so the agreed terms are included as text.
