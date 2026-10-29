# Local development candidate — execution requires separate approval

All commands here are PREPARED, NOT RUN. The original Windows workstation, WSL and Docker
remain restricted. Use only a separately approved independent environment and a reviewed
copy of the current source, including untracked files. Do not point any command at the
October temporary containers, their Compose project, volumes, credentials or data.

## Topology

Native Linux Node 24 API at `127.0.0.1:3100`, native Next development server at
`127.0.0.1:3101`; new dependency-only Compose project with single-node Mongo replica
on `127.0.0.1:27117`, SMTP capture on `127.0.0.1:11025` and capture UI on
`127.0.0.1:18025`. No Redis is required by the inspected startup path. Storage remains
unconfigured, so media operations are unavailable. No workers start with this topology.

Host chronyd stays host-managed and unchanged. The ordinary dev API cannot issue qualified
Package consent: all production gates remain denied. The isolated Vitest lane below uses
the existing synthetic authority, fake gateway, real domain services and disposable Mongo
replicas. It does not turn the interactive dev server into a synthetic purchase service.

The Mongo service is unauthenticated and loopback-only for synthetic data. Its member
advertises `127.0.0.1:27117`, matching BOTH its container listener and native-client port.
Only native host clients are supported by that advertised address. Initialization uses
the Compose service address only to bootstrap the new replica; it never reconfigures one.
No fixed container names or external networks/volumes are used. Dependencies share an
internal network; host/native process and browser egress require independent controls.
Mailpit has no relay/release configuration, and its automatic version check is disabled.

## Preflight, on the approved environment only

1. Record approval, source candidate hashes and isolation. Reject operational `.env*` in
   API/Client roots, old credentials/configuration, source credentials and inherited provider
   variables. Use a new HOME/browser profile and no production/customer data. Next loads env
   files on startup; passing a clean template does not disable that behavior.
2. Record Node 24 (Owner reports 24.21.0 locally; not independently checked), pnpm 11.17.0,
   native module provenance, Mongo binary, browser and image versions/digests. Provision
   dependencies/binaries via the approved provisioning path; no install is authorized here.
   Frozen installs use `pnpm install --frozen-lockfile --ignore-scripts` in each repo; native
   argon2 provisioning remains explicit. Do not run prepare hooks or unrestricted rebuilds.
3. Select reviewed immutable Mongo and Mailpit image digests and make them available before
   runtime egress is restricted. Mailpit must support the configured options. The independent
   runner must deny external runtime/provider egress while allowing test-owned loopback and
   approved dependency ports. No live Stripe/Google/Email/SMS/S3 keys, even test-account keys.
4. Verify ports/project name are unused by any unrelated workload. Refuse collisions; do not
   stop/reuse old containers. If Docker Desktop loopback publishing is unreachable from the
   native Linux process, record that environment blocker; do not publish on `0.0.0.0` as a fix.

From the approved API repository, prepare local copies (no secrets in these templates):

```bash
cp dev/local/images.env.template dev/local/images.env.local
cp dev/local/api.env.template dev/local/api.env.local
cp dev/local/client.env.template dev/local/client.env.local
```

Operator fills the two image references with approved `repository@sha256:...` values in
`images.env.local`. These copies are ignored. Fixed dev-only SMTP/OTP strings are not real
credentials. Keep all provider and activation variables absent. No HMAC key/profile is
injected into the dev API. Validate configuration on the approved host before starting:

```bash
docker compose --project-name bookly-p4j-isolated --env-file dev/local/images.env.local -f dev/local/compose.yaml config --quiet
docker compose --project-name bookly-p4j-isolated --env-file dev/local/images.env.local -f dev/local/compose.yaml up -d mongo mail
docker compose --project-name bookly-p4j-isolated --env-file dev/local/images.env.local -f dev/local/compose.yaml --profile setup run --rm mongo-init
```

`mongo-init` waits for a writable primary and rejects unexpected existing replica identity.
Use a new project-owned volume. Do not import backups, seed production users or run broad
`sync:indexes`. Existing development Mongoose startup creates declared indexes automatically
only in the explicitly selected synthetic database; production behavior is unchanged.

## Native development processes

Use an isolated shell with an approved PATH and HOME, no inherited secrets. Define
`BOOKLY_APPROVED_PATH` and `BOOKLY_RUNNER_HOME` to those reviewed locations first.
These commands use an explicitly absent dotenv path; the source checkout must still pass
the no-operational-env-file preflight. Commands are separate foreground terminals.

From API:

```bash
env -i PATH="${BOOKLY_APPROVED_PATH:?}" HOME="${BOOKLY_RUNNER_HOME:?}" DOTENV_CONFIG_PATH=/nonexistent/bookly-p4j-disabled.env node --env-file=dev/local/api.env.local --import tsx --watch src/app/server.ts
```

From Client:

```bash
env -i PATH="${BOOKLY_APPROVED_PATH:?}" HOME="${BOOKLY_RUNNER_HOME:?}" node --env-file=../api/dev/local/client.env.local node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3101
```

Use `http://127.0.0.1:3101` consistently for cookies/CORS; do not mix localhost and IP hosts.
API health is `http://127.0.0.1:3100/health`. SMTP capture UI is
`http://127.0.0.1:18025`. Browser connections/assets must also respect the approved egress
policy; unavailable third-party fonts/maps are not permission to enable providers.
Create only synthetic accounts through existing flows (email capture and dummy phone OTP).
No default admin password or new unrestricted seed endpoint is provided.

## Isolated Package verification (independent of the development database)

Provision a reviewed Linux Mongo binary for mongodb-memory-server-core in advance and set
`BOOKLY_APPROVED_MONGOD` to its absolute path; record its version/hash. No download fallback.
Do not pass the Compose MONGODB_URI to tests. The existing helper starts its own replica and
unique random database, with additive fixture indexes and cleanup of only that test database.

From API, in the same approved isolated environment:

```bash
env -i PATH="${BOOKLY_APPROVED_PATH:?}" HOME="${BOOKLY_RUNNER_HOME:?}" DOTENV_CONFIG_PATH=/nonexistent/bookly-p4j-disabled.env MONGOMS_SYSTEM_BINARY="${BOOKLY_APPROVED_MONGOD:?}" MONGOMS_RUNTIME_DOWNLOAD=false pnpm run typecheck
env -i PATH="${BOOKLY_APPROVED_PATH:?}" HOME="${BOOKLY_RUNNER_HOME:?}" DOTENV_CONFIG_PATH=/nonexistent/bookly-p4j-disabled.env MONGOMS_SYSTEM_BINARY="${BOOKLY_APPROVED_MONGOD:?}" MONGOMS_RUNTIME_DOWNLOAD=false pnpm exec vitest run --config vitest.booking-local.config.ts
```

Retain stdout/stderr/exit codes and actual collection/pass/fail/skip counts. A setup failure
is a failure to verify, not a pass. This lane selects existing cases for retained quote,
strict acceptance/certification, HTTP ownership, real Mongo majority evidence, original
fake payment/3DS continuation, genuine v2 completion within the isolated contract, member
Bookings, credits and lifecycle/redemption. It also includes default-denied gate/history
tests and the new Chrony parser vectors. Synthetic host policy is test-only and the fake
gateway never contacts Stripe. Never move its profiles, rollout mocks, records or certificates
into a development/production entitlement database. No global environment switch is added.

From Client, in the isolated shell after rejecting root operational env files:

```bash
pnpm exec next typegen
pnpm exec tsc --noEmit
pnpm exec vitest run tests/package-consent.test.tsx tests/package-consent-page.test.tsx tests/package-purchase.test.tsx tests/package-purchase-address.test.tsx tests/package-lifecycle.test.tsx tests/package-view-transport.test.tsx
```

Client tests mock transport/Stripe continuation; they are not a live browser payment checkout.
Execute ordinary Booking/C1/payment/recovery regressions and actual browser role/cache/layout
checks separately before acceptance. Real interactive First-Class checkout stays unavailable
until independently qualified authority and explicit coordinated release; no bypass is prepared.

## Stop without touching old containers

Stop native foreground processes normally. After approval, stop ONLY this dependency project:

```bash
docker compose --project-name bookly-p4j-isolated --env-file dev/local/images.env.local -f dev/local/compose.yaml stop
```

No volume deletion/prune, orphan removal, old-project shutdown, clock modification, key
rotation, activation or deployment command is part of this preparation.

## P4K isolated interactive Package simulation (separate from the dev API above)

**Isolated interactive Package simulation is NOT real qualified First-Class Purchase
activation.** It runs the shipped `ExpressApplication` inside the dedicated Vitest config
`vitest.p4k-interactive.config.ts`, whose setup file alone substitutes: the batch rollout
gate, the qualified consent host and its synthetic HMAC observation, the shipped Consent HTTP
activation value ({ enabled: true }), one in-memory fake Stripe payment/tax gateway (real SDK/client throw),
and capture-only email transports. Real deadline assessment, majority evidence, F2 financial
persistence, member Booking creation, PackageProgress and the genuine v2 completion verifier
run unchanged. The normal dev API above, `pnpm dev`, `pnpm build` and the production image
contain none of this (harness lives in `tests/interactive/`, files end `.p4k.ts`).

Every result is *valid under isolated synthetic test authority* only: it never authorizes a
real charge, entitlement, Calendar release or settlement. The harness launches its own
disposable loopback replica (refuses an inherited `MONGODB_URI`), seeds only synthetic
`@p4k.invalid` accounts and discards everything on stop. Never copy its data, profiles or
evidence into any development, staging or production database. Do not run the Compose
dependencies for this lane; it does not use them.

Same approved environment, provisioned Mongo binary and egress controls as the lane above.
Manual in-browser session, from API (API `127.0.0.1:3100`, Client `127.0.0.1:3101`, console
`127.0.0.1:3199`). Use a clean Client checkout with no `.env*` files; the session starts that
Client itself, pointed only at this API, and opens a **visible isolated Chrome window**:

```bash
env -i PATH="${BOOKLY_APPROVED_PATH:?}" HOME="${BOOKLY_RUNNER_HOME:?}" DISPLAY="${DISPLAY:-}" MONGOMS_SYSTEM_BINARY="${BOOKLY_APPROVED_MONGOD:?}" MONGOMS_RUNTIME_DOWNLOAD=false BOOKLY_TEST_BROWSER="${BOOKLY_APPROVED_CHROME:?}" BOOKLY_P4K_CLIENT_ROOT="${BOOKLY_P4K_CLEAN_CLIENT:?}" BOOKLY_P4K_INTERACTIVE=1 pnpm exec vitest run --config vitest.p4k-interactive.config.ts tests/interactive/interactive-session.p4k.ts
```

(The setup file itself disables dotenv loading, so an `api/.env` cannot re-add `MONGODB_URI` or
provider keys; the harness also refuses to start if any provider variable is present.)

Use only the opened window. It has a fresh profile, resolves only `127.0.0.1`, and answers the
Stripe.js request with a local simulation. An ordinary browser has no simulation and must not
be pointed at this Client. The session prints the synthetic password, accounts, start URLs and
the console URL (`http://127.0.0.1:3199/#token=…`): the per-session token is in the fragment,
is required by every console request, and is never available to the app's origin. Do not share it.

Journey in the window: venue page → Packages filter ("Checkout available") → View details →
add initial appointments → Review selected terms → accept → Purchase this Package → verified
Package → owned detail → Book a remaining session.
- 3DS: before purchasing, press `requires_action` in the console. When the page shows
  `PAYMENT_PENDING`, press "Continue secure payment authentication"; the page shows a
  "Simulated 3DS challenge" dialog (Complete / Fail / Cancel). Only the fake PaymentIntent
  changes; the server must still verify and persist the purchase.
- Decline / lost response: press `failed` / `lost` before purchasing; reload and use
  "Check original purchase status" / "Retry original purchase" for the same operation.
- Strict deadline: present terms, press `SKEW +30 min +1 ms` (or `UNAVAILABLE`), then accept;
  certification and purchase must stay closed. Press `NORMAL` afterwards.
- Remaining-session redemption needs the original venue balance recorded first: sign in as the
  synthetic Owner, open the Customer's Package booking from the business dashboard's client
  history and use "Record venue settlement" (Full).

Without `BOOKLY_P4K_CLIENT_ROOT`/`BOOKLY_TEST_BROWSER` the session starts only the API and
console (useful for API-level checks); in-page 3DS then has no simulation.

Authored browser journeys (12 + at-home, venue entry, manual 3DS dialog, owned counts, credit exhaustion), real Next dev server + approved Chrome, from API:

```bash
env -i PATH="${BOOKLY_APPROVED_PATH:?}" HOME="${BOOKLY_RUNNER_HOME:?}" DOTENV_CONFIG_PATH=/nonexistent/bookly-p4j-disabled.env MONGOMS_SYSTEM_BINARY="${BOOKLY_APPROVED_MONGOD:?}" MONGOMS_RUNTIME_DOWNLOAD=false BOOKLY_TEST_BROWSER="${BOOKLY_APPROVED_CHROME:?}" BOOKLY_P4K_CLIENT_ROOT="$(cd ../client && pwd)" BOOKLY_P4K_BROWSER_ARTIFACTS="${BOOKLY_P4K_EVIDENCE_DIR:?}" pnpm exec vitest run --config vitest.p4k-interactive.config.ts tests/interactive/browser-journeys.p4k.ts
```

The evidence directory must be new and empty; the Client root must have no `.env*` files.
The driver answers only the Stripe.js script request with a local stub (3DS results go to the
harness process through a CDP binding, not over the network) and fails every other non-loopback
request. Retain stdout/stderr/exit code, `p4k-browser-results.json` and
screenshots. A setup failure is a failure to verify, not a pass. Stop with Ctrl+C; nothing else
(no containers, volumes, clocks or providers) is touched.
