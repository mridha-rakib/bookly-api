# Money recovery worker runtime contract

Source prepared 26 October 2026. **NOT VERIFIED. No activation or deployment authorized.**

## Explicit activation

The existing `ecosystem.config.cjs` and Docker API command are unchanged. The separate
`ecosystem.money-recovery.config.cjs` describes only `bookly-money-recovery`, using one
forked Node process with its working directory fixed to the API directory. It launches
`dist/scripts/run-money-recovery-worker.js`, the output expected from the existing
`src` → `dist` TypeScript build. Actual artifact existence and production dependency
closure must be verified by a trusted build. The development package scripts still
use `tsx`; do not assume it exists with production-only dependencies.

Before separately authorizing activation, the operator must verify that no other
money recovery consumer runs against the same database (including other PM2 daemons,
hosts, containers, schedulers and manual `--once` invocations). Confirm the reviewed
source/artifact and environment on an independently trusted host. Then explicitly
supply both variables through that target's approved configuration mechanism:

```text
BOOKLY_MONEY_RECOVERY_WORKER_ENABLED=true
BOOKLY_MONEY_RECOVERY_SINGLE_WORKER_CONFIRMED=true
```

Neither variable is set by the ecosystem file. Existing shared application environment
validation still applies, including production-required settings; explicit nonempty
`MONGODB_URI` and `STRIPE_SECRET_KEY` are also required by the CLI launch guard. These
values are secret configuration, never instructions to paste credentials into reports.
Use approved synthetic configuration for verification, not real Customer data or keys.
`NODE_APP_INSTANCE` may be absent or `0`; other values and a present `NODE_UNIQUE_ID`
are refused. Only the optional single `--once` argument is accepted. The same guard
applies to direct CLI execution and the existing development package scripts.

The acknowledgements express operator intent, **not a distributed lock or security
authority**. Two hosts can both pass them. Fork/instances settings bound this process
definition only. Multi-worker/multi-host deployment is unsupported by this contract;
if the hosting platform cannot enforce one consumer, do not activate. A global lease
or a changed payment protocol requires a separate approved design.

On the approved PM2 host only, a later authorized operator would select the separate
ecosystem file to start the worker, and address `bookly-money-recovery` independently
for stop/restart/status/log inspection. No automatic PM2 save/startup registration is
part of this change. Do not run those operations on the flagged workstation. The
Dockerfile remains API-only; this does not introduce a container orchestrator or a
worker container service. Its API HTTP healthcheck is not a worker healthcheck.

## Lifecycle and observability

Signal handlers are installed before database connection. A stop during connection
prevents the first recovery pass after connection settles. A stop during a pass lets
that pass finish before disconnecting. The idle 30-second wait is interruptible. An
exception still attempts disconnect and removes signal handlers. There is no injected
cancellation of a financial operation and no release of claims on a signal.

The existing continuous loop awaits each pass and then waits 30 seconds. Pass errors
are logged and polling continues. Nonzero service error/webhook-failure counts generate
a warning rather than a success-level heartbeat. CLI startup/one-shot/fatal failure
sets exit code 1. New wrapper error logs use fixed event/reason messages, never raw
provider exceptions or environment values. Existing inner services/database logging
and shared redaction are unchanged; end-to-end log privacy still requires trusted tests.

PM2 restart delay is 5 seconds, unstable restarts are bounded by the configured 30-second
minimum uptime/10-restart policy, and memory restart is 512M. Inspect real manager behavior
and alerts in trusted acceptance; configuration text is not an observed process result.
Monitor fatal events, partial-pass warnings, missing pass heartbeats, retry backlog/age
and manager stopped/errored state. A pass count is an observation count, not proof that
money settled. No bank receipt, successful Booking or settlement is inferred from startup.

The PM2 stop grace is 120 seconds. It does not bound provider/database work; an active
pass can exceed it and the manager can forcibly terminate the process. Hard kill, host
loss, memory restart and crash recovery rely on existing durable domain records, leases,
claim tokens and idempotency. No new global crash-atomicity guarantee is introduced.
Verify SIGINT/SIGTERM, slow pass and hard-kill/restart scenarios before activation.

## Recovery authority preserved

`buildService` still composes the real Stripe gateway, PaymentService, attempt/refund
repositories, Booking/ledger services, package repository, financial relationship and
penalty services, webhook recovery and provider reversal backstop. This is a live-capable
worker; placeholder-looking keys do not make it a fake. Unit tests inject mocks; actual
test-provider operations need separately approved synthetic accounts and scoped egress.

The worker observes persisted/provider facts through the existing MoneyRecoveryService.
An ordinary succeeded attempt with an existing Booking and matching source ledger is
completed only under persistence ownership. A genuine aged orphan follows existing
guarded compensation/refund behavior; the worker does not recreate the Booking or run
new scheduling admission. Missing/ambiguous evidence remains unresolved. Refund and ledger
recovery use their existing durable identities. First-class activation denial remains
in place; worker enablement does not grant Package activation authority.

Per-record claim/idempotency protections also coordinate with API/webhook activity.
Recoverable-list reads are not a global worker claim and serial polling is not a leader
lease. Do not promise every repeated provider observation is suppressed. Actual no-double
charge/refund/Booking/reservation/ledger results require existing database/concurrency
regressions, not only mocked orchestration tests.

## Required trusted acceptance

After independent host/source/target approval, build and verify the compiled path with
production dependencies; run launch/lifecycle/config and recovery unit tests, then existing
payment durability, financial relationship, Booking payment, provider reversal and Package
denial suites. Test provider-success/persistence interruption, authoritative compensation,
duplicate observations, existing Booking, stale-owner rejection, crash/restart and uncertain
provider evidence. Inspect persisted Booking/reservation/ledger/attempt/refund facts and logs.
Then verify real PM2 start/stop/restart/drain/backoff on isolated infrastructure. Do not run
the CLI against live services merely to test process supervision. All checks are NOT RUN
in the source-preparation session. Deployment, process activation and production index or
credential provisioning remain separately authorized operations.
