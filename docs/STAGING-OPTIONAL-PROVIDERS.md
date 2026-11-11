# Private staging provider configuration

This source change does not activate a deployment or authorize databases, objects, financial operations, enrollment or optional workers.

## Email

Only the selected EMAIL_PROVIDER requires its credentials:

- sendgrid: SENDGRID_API_KEY and EMAIL_FROM; EMAIL_FROM_NAME retains the existing default.
- resend: RESEND_API_KEY, RESEND_FROM_EMAIL and RESEND_FROM_NAME.
- smtp: SMTP_HOST, SMTP_USER, SMTP_PASS and EMAIL_FROM, with the existing port/TLS configuration.

Do not fabricate credentials or configure another provider merely to pass validation.

## Apple pending state

APPLE_OAUTH_ENABLED defaults to true, preserving mandatory Apple configuration in production. A production-mode deployment may explicitly set it false only with both exact private staging origins:

```
FRONTEND_BASE_URL=https://staging.bookly.cy
PUBLIC_API_BASE_URL=https://api-staging.bookly.cy/api/v1
APPLE_OAUTH_ENABLED=false
```

That state accepts absent Apple credentials/redirects, rejects Apple login/start/callback and account-link OAuth routes with 503 before session/provider work, and prevents client-secret generation. Existing authenticated unlink is preserved so linked identities can still be removed safely. It does not allow login without Apple verification or bypass 2FA.

GET /api/v1/auth/providers returns no-store, non-secret Apple capabilities. Client login pages and the new-link control appear only on a positive backend capability response; pending, missing, invalid and failed discovery hides them. There is no separate public Apple feature flag to drift from API configuration. Existing linked identity state remains visible/unlinkable.

Default/true production mode still requires Apple keys and callback URLs. Enabling the provider requires real key material, registered redirects, existing signature/state/nonce/claim checks and matching Client/API releases. No mock key is suitable for runtime deployment.

## Production startup resources

Production Mongoose connections disable autoCreate as well as autoIndex. Production S3 ensureBucket performs HEAD only and fails closed if the existing bucket cannot be verified; it never falls back to CreateBucket. Local development retains its existing provisioning behavior. All production collections/indexes and buckets must be separately approved/provisioned before startup. These guards do not authorize provisioning.
