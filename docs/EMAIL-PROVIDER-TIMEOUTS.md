# Email provider outcomes and timeouts

F4A Tier 1, 26 October 2026. **NOT VERIFIED.** Applies to every consumer of the shared
transports: the email outbox worker (Booking and other transactional emails), synchronous OTP
and notice emails, support emails and the marketing worker.

## Outcome categories

| Situation | Category | Retryable | Worker result |
|---|---|---|---|
| Provider returned success | — (`PROVIDER_ACCEPTED`) | — | `SENT` (acceptance, not inbox delivery) |
| Provider returned 429 | `RATE_LIMITED` | yes | retry |
| Provider returned 5xx / unclassified | `PROVIDER_TRANSIENT` | yes | retry |
| Connection never established (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`) | `NETWORK_TRANSIENT` | yes | retry |
| Timeout, abort or dropped connection after (possibly) sending | `PROVIDER_OUTCOME_UNKNOWN` | yes | retry; the email **may** already have been accepted |
| Provider returned 400 / 401 / 403 / other 4xx | `INVALID_MESSAGE` / `PROVIDER_AUTH_ERROR` / `PROVIDER_PERMISSION_OR_SENDER_ERROR` / `PROVIDER_PERMANENT` | no | `FAILED` |
| Bookly not configured | `NOT_CONFIGURED` | no | `FAILED` |

SMTP (F4A Tier 3): nodemailer's `responseCode` is an SMTP reply, not an HTTP status. 4xx →
`PROVIDER_TRANSIENT` (retry); 530/534/535 → `PROVIDER_AUTH_ERROR`; 500/501/503/504/552/555 →
`INVALID_MESSAGE`; other 5xx → `PROVIDER_PERMANENT`. Previously 5xx was retried and 4xx failed.

`PROVIDER_OUTCOME_UNKNOWN` is never treated as a rejection. A row only becomes `FAILED` after
a permanent error or exhausted attempts. Retrying an unknown outcome can produce a duplicate
email: delivery is at-least-once.

## Resend

`resend@6` returns `{ data, error }` and does not throw on HTTP or network failure. The
transport now throws for a returned `error`: a numeric `statusCode` is classified as above,
and `statusCode: null` (no HTTP response, including our abort) is `PROVIDER_OUTCOME_UNKNOWN`.
Before this change a returned error was recorded as accepted (`SENT`). Errors carry only the
provider error name and status, never its message body.

## Request limits (`EMAIL_PROVIDER_REQUEST_TIMEOUT_MS` = 30 s)

| Transport | Mechanism | Strength |
|---|---|---|
| Resend | `AbortSignal.timeout(30 s)` passed to `emails.send`; the SDK spreads it into `fetch` | Wall-clock, cancels the request including the body read |
| SendGrid | `sgMail.setTimeout(30 s)` → axios `timeout` → `follow-redirects` timer | Wall-clock from socket assignment to response headers; the request is aborted and destroyed. The response body (202, empty) is read afterwards |
| SMTP | nodemailer `connectionTimeout` 10 s, `greetingTimeout` 10 s, `dnsTimeout` 10 s, `socketTimeout` 30 s | **Per phase only.** nodemailer has no per-message abort. A session that keeps making slow progress can exceed 30 s in total |

Ordering: provider limit (30 s) < email worker drain grace (`kill_timeout` 60 s) < claim
timeout (`EMAIL_OUTBOX_CLAIM_TIMEOUT_MS` default 120 s). Keep it when changing any of them.
A local invoice-PDF generation before the send is not covered by these limits.

## Idempotency

Not enabled. Resend supports an `Idempotency-Key`. Using the outbox `dedupeKey` would need:
a hashed key within Resend's length limit, a byte-identical payload on every retry (the
BOOKING_COMPLETED invoice PDF is regenerated per attempt), and a decision on how to map
Resend's idempotency conflicts. That is a separate decision. SendGrid and SMTP have no
equivalent.
