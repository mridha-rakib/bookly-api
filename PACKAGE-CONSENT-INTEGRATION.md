# Package consent integration (P3-B1c)

## Current shipped status — strict authority remains blocked

The shipped `createPackageConsentRoute()` composition denies regardless of
`PACKAGE_CONSENT_ENABLED`. The current Customer destination is read-only and
does not render consent finalization. `verifyPackageBatchActivation()` always
throws; no runtime flag, environment mode or application route grants activation.

The retained `ACCEPTED_IMMUTABLE` engineering record proves an exact authenticated
action/disclosure binding, **not** authoritative persistence before the original
quote's strict deadline. Its `acceptedAt` is an application-clock sample before
the later database update. Neither this sample nor a database-generated update
timestamp is automatically the durable commit time. `$$NOW` may also precede a
contended write's eventual completion. No grace, renewal, timezone conversion or
request-time substitution is permitted.

The approved activation deadline is strictly before original `issuedAt + 1,800,000ms`.
The historical configurable quote TTL below does not authorize changing that contract.

The local characterization tests in `package-consent-mongo-clock.integration.test.ts`,
`package-consent-boundaries.integration.test.ts` and
`package-b1c-authority-proof.integration.test.ts` distinguish these counterexamples
from a proven consent mechanism. Production Purchase/Consent stays unavailable.

## Historical engineering-only integration notes

The following describes the earlier isolated explicit-factory test seam and UI,
not current shipped behavior. Its flag table and editable UI instructions cannot
enable the current application. Retained action evidence alone is not B1c authority.

This surface records terms acceptance only. It cannot buy a Package, reserve a slot,
create Bookings/PackageProgress, charge a card or enable monetary penalties.

Both gates default off. No deployed configuration is changed by this implementation.

|Server setting|Default|Purpose|
|---|---|---|
|API `PACKAGE_CONSENT_ENABLED`|`false`|Enables consent-only HTTP routes|
|API `PACKAGE_CONSENT_QUOTE_LIFETIME_MS`|`1800000`|Owner-approved configurable 30-minute unaccepted quote lifetime|
|Next server `PACKAGE_CONSENT_UI_ENABLED`|unset/off|Shows the protected terms selection/review page|

The quote expiry is original server issuance in UTC plus the configured lifetime.
Retries, presentation retrieval, reloads and acceptance attempts never extend it.
Expired unaccepted offers need a new operation/quote and new affirmation. Original
offers and committed acceptance evidence remain retained for audit/replay.
Quote expiry is separate from purchased FINITE6/FINITE12/FOREVER validity. No
payment/3DS grace or final purchasedAt/expiresAt is established here.

The enabled Customer entry is:

`/customer/package-consent/<businessId>/<packageId>`

There is no normal discovery/purchase link. This initial UI supports at-Business
appointments with server-owned Service/provider options, one or more initial
appointments, and no add-on/travel picker. A canonical intent submitted through
the API still receives all existing eligibility/availability/extra/policy checks.
Dates in the picker use the device timezone; exact terms show the Business zone.
A quote never reserves or guarantees availability.

API paths under `/api/v1/package-consent`:

- `GET /:businessId/offers/:packageId`: server-owned selection options.
- `POST /:businessId/quotes`: `{ operationId, intent }`; client IDs are selectors,
  never seed/Booking/progress/origin/financial authority. Operation UUIDs are
  namespaced to the verified Customer server-side.
- `POST /:businessId/operations/:operationId/presentation`: empty object; returns
  version, presentationId, challenge, templateVersion, quoteHash, disclosureHash,
  exact text and, when already committed, a sanitized accepted result.
- `POST /:businessId/operations/:operationId/acceptance`: the existing strict
  version1 `ACCEPT_PACKAGE_CHECKOUT_TERMS` action and bound content identities.
- `GET /:businessId/operations/:operationId/acceptance`: sanitized canonical
  committed result or `NOT_ACCEPTED`.

All operations require Bearer authentication, live session family, active Customer
and ownership. Explicit Origins must match the API allowlist. Cookies alone do
not authenticate this surface. Private session-family identifiers, grants and
server seeds are never response DTOs. Responses are `no-store`.

The UI renders exact terms as text, starts unchecked, requires a separate submit,
retains the same event UUID for a manual network retry, and verifies response
presentation/quote/disclosure identity. It shows “Terms accepted” and explicitly
states no purchase has been made. It has no payment continuation.

Normal request budget: four consent requests (offer, quote, presentation,
acceptance). A retained operation reload needs one presentation request; accepted
evidence can be returned with it. No polling or automatic query/mutation retries.
The existing shared API client may perform its bounded access-token refresh; its
session architecture and global rate limits are unchanged.

Tests use isolated disposable MongoDB and no provider. The optional local Chrome
exercise in `package-consent-http.integration.test.ts` uses
`BOOKLY_CONSENT_BROWSER_ARTIFACTS` pointing to a temporary prepared actual-component
bundle (`consent-browser.js`) and Tailwind stylesheet (`consent-browser.css`). The
implementation report's artifact directory retains the exact build scripts,
sanitized runner, logs and mobile/desktop screenshots. It is a component-to-real-API
browser test, not a complete Next/login/deployment E2E certification or proof of
human consent in production. Purchase activation and payment recovery remain B2/B3.
