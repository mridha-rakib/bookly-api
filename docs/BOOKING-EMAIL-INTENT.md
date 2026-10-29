# Booking-created email intent (F4A Tier 2)

27 October 2026. **NOT VERIFIED.** Supersedes the "Booking-created notifications are enqueued
after the Booking transaction commits" gap listed in `docs/EMAIL-WORKER.md`.

## Behavior

The booking-created EmailOutbox rows (`eventKey = BOOKING_CREATED:<bookingId>`) are written
**inside** the Booking transaction, as the last domain write of each callback:

| Path | Method | Position |
|---|---|---|
| Customer booking and legacy Package purchase | `persistCustomerBooking` | after the FIRST-relationship consume, before `markPaymentCompleted` |
| Package session redemption | `redeemPackageSession` | after the ledger write, before `markPaymentCompleted` |
| Manual (Owner/Supervisor) booking | `persistBooking` | after the Booking write |

- The rows commit if and only if the Booking commits. The worker cannot see them earlier.
- Recipients, templates, payloads, event keys and dedupe keys are unchanged.
- The post-commit tail (`afterBookingCommitted`) no longer enqueues this email. Google
  Calendar sync and reminder scheduling stay post-commit and best-effort.

## Failure rules (Owner decisions O1/O2)

- **Outbox insert fails:** the transaction aborts. A manual or free booking releases its
  idempotency claim, as on any other abort. A paid booking enters the existing
  `markPaymentCompensationRequired` → compensation path. The rollback itself is not a refund;
  refund confirmation is decided only by the existing provider-backed recovery.
- **User lookup fails** (owner/supervisor address): the Booking still commits; only the
  business-side rows are skipped and a warning is logged.
- **Payload cannot be built:** F4A Tier 3 — the transaction aborts (same path as an insert
  failure). Building is a pure function of the Booking being committed, so a failure is a
  defect; it must not leave a committed Booking with no confirmation intent.
- **Transient transaction retry:** the driver re-runs the callback; the aborted attempt's rows
  are discarded, so each recipient ends up with exactly one row.
- **Replay of a committed operation:** returns the existing Booking; no new rows.

## Deployment

The `EmailOutbox` collection and its unique `dedupeKey` index must exist before Bookings write
to it inside transactions. Run the existing `sync-indexes` step first.

Bookings committed before this change keep whatever the old post-commit path produced; nothing
is backfilled.
