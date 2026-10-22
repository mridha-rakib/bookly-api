# Consent V1 verification

From API, with installed dependencies, MongoDB 8.2.6 and (for browser tests) local Chrome:

```text
node tests/run-package-consent-v1.cjs
node tests/run-package-consent-v1.cjs --next
```

The test-only runner strips inherited credentials, prevents application dotenv loading,
blocks nonlocal Node network connections, disables Mongo downloads and retains logs in
a new temp directory. It never enables a deployed flag. Read `--help` before running.

`consent-isolated-database.ts` launches a fresh loopback replica, checks host/port/database
identity and an empty database before writing, and creates only new test collections and
indexes. It never calls syncIndexes. Clear operations verify a private ownership marker.
The replica is stopped after tests; shared database URIs are never accepted.

The optional `package-consent-next.integration.test.ts` starts the real auth router,
real consent composition and validated persisted domain rows. It imports the Client's
`tests/e2e/package-consent-next.mjs` harness. That harness byte-copies the checked-out
Client into a unique temp directory, excludes dotenv files, links installed dependencies,
starts Next on loopback and drives the actual protected page/password login in Chrome.
No auth wrapper, consent component, API or persistence mock is used in that E2E. External
Google font CSS alone is replaced with a local-font fixture. Development route compilation
is warmed before browser navigation; filesystem polling avoids a Windows watcher crash.
Only spawned test PIDs are terminated. Source repositories are not build output targets.

Boundary tests use actual HTTP, JWT/users/session families and Mongo persistence with
synthetic quote domain reads and an explicitly controlled server quote clock. They include
a characterization of the existing behavior when a verified grant's Mongo dispatch is
held until after quote expiry. Its passing assertion records that late write is currently
permitted; it does not certify a strict atomic-write deadline or endorse that behavior.
Acknowledgement delay is tested separately from dispatch delay. No production acceptance
semantics, quote TTL, disclosure text or feature defaults are changed by these tests.

Purchase/payment/penalty activation remains outside this harness. This is automated test
consent from synthetic accounts, not evidence of a production person's agreement.
