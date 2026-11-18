# Promo Codes on Package Purchases: decisions required before enabling

Status: **DISABLED pending Owner decisions** (2026-11-18). No code path accepts or applies a
Promo Code to a package purchase. `tests/unit/package-promo-disabled.test.ts` fails if any
package path starts accepting one.

## Why it is not enabled yet

The Owner asked for Promo Codes on Package Purchases. The source records the current rule as a
confirmed product decision ("NORMAL bookings only (never package purchase/redemption/Session 2+)
… do not reinterpret", `src/modules/promo/promo.types.ts`). Every package layer enforces it:

- The legacy purchase body omits `promoCode` (`booking.schema.ts`, `packagePurchaseBodySchema`).
- The First-Class intent and quote bodies are strict, with no promo field
  (`package-checkout-contract.ts`, `package-consent.route.ts`).
- A package contract is V2, and V2 never carries promo terms. V3 (the promo contract) is
  NORMAL_BOOKING only (`financial-contract.ts`).
- The First-Class batch contract requires `promoDiscountCents: 0`
  (`package-batch-completion-contract.ts`).

Reusing the NORMAL mechanics for packages would **change financial ownership**. A NORMAL promo
reduces the price **before** the upfront is computed (`promo-application.service.ts`,
`fundingOwner: "BUSINESS"`). For a FIRST package, the upfront is Bookly's 20% PLATFORM_FEE on
the bundle price, so a discounted bundle would also reduce Bookly's fee. The discount would then
be partly Bookly-funded. The directive forbids introducing Bookly-funded discounts or altering
ownership without an approved policy. So no implementation was made.

## Decisions the Owner must make (each one changes money)

| # | Decision | Options |
|---|---|---|
| D1 | Which products | First-Class Packages, legacy Package Deal services, or both |
| D2 | Who funds the discount | (a) Business only: Bookly's FIRST fee is computed on the **list** bundle price, and the discount reduces only the Business-owned remainder paid at the venue. (b) Shared, as NORMAL today: the fee is computed on the discounted price. (c) Bookly-funded through a subsidy. |
| D3 | What is discounted | Bundle price only, or also add-ons and travel (NORMAL excludes travel) |
| D4 | RETURNING customers | Nothing is charged online (€0), so a discount only lowers the amount paid at the venue. Decide how that is disclosed in the accepted terms and enforced at the venue. |
| D5 | Penalty basis | Do late-cancel, no-show caps and `soldBundlePriceCents` use the list or the discounted bundle price? |
| D6 | Per-session value and refunds | The value per session for forfeiture or late cancellation, and the refund on void (today a void refunds the upfront only when the package is fully unused). Decide whether promo usage is restored on void or Business cancellation. |
| D7 | Eligibility and limits | An explicit per-promo opt-in (proposed: `packagePurchaseEligible`, default **false** for every existing and new promo, so no NORMAL promo is reinterpreted). What `ALL_FIRST_BOOKINGS` means for a package. Counting: one redemption per package purchase, never per session. |

## What an approved implementation must keep (from the directive)

- Discount the purchase once, server-side, in integer cents.
- Freeze the discount in a new package contract version, and keep it identical across the
  preview, retained quote, `termsHash`, accepted terms, PaymentIntent amount, receipt, ledger and
  refund.
- Never re-apply it at session redemption.
- Re-validate eligibility, limits and expiry at the authoritative purchase commit, with the
  existing transactional redemption claim and concurrency guarantees.
- Keep Stripe idempotency and recovery, the 30-minute consent deadline
  (`PACKAGE_CONSENT_STRICT_LIFETIME_MS`), and the FOREVER, 6-month and 12-month expiry modes.
- First-Class activation and signed deployment authority are never bypassed. The change ships
  only in a newly signed release.
