# Local acceptance composition (BC-F05C) — NON-PRODUCTION ONLY

Owner-approved, separate entry point that lets a person test First-Class Package purchase locally on Windows.
It is **not** production-qualified consent and must never be deployed.

```powershell
# from api/
node --import tsx dev/local-acceptance/init-authority.ts ..\local-acceptance\authority   # once
$env:DOTENV_CONFIG_PATH = "..\local-acceptance\api.local.env"
node --import tsx --import ./dev/local-acceptance/register.mjs dev/local-acceptance/server.ts
```

What it changes, only inside this process (module-resolution hook, `hooks.mjs`):

| Shipped module | Local acceptance replacement |
|---|---|
| `package-batch-authority` | Batch rollout gate resolves after the composition check |
| `trusted-time/qualified-host` | Current issuer = local authority; history verifies only the exact local identity |
| `trusted-time/host-clock` → `observeConsentHost` | Windows wall clock with a declared ±1,000 ms bound, sealed with the local key (shipped verifier unchanged) |
| `package-consent-http-activation` | `{ enabled: true }`; consent lifetime stays exactly 1,800,000 ms |

Everything else is shipped code: consent protocol/certification/deadline, v2 completion proof, batch and financial persistence, reservations, ledger, PackageProgressV2, lifecycle, roles, **real Stripe gateway** (no fake provider), and Calendar production authority (still denied).

Startup refuses: `NODE_ENV` other than `development`; `api/.env` or any env file outside a `local-acceptance` folder; SRV/remote/credentialed MongoDB or any database other than `bookly_local_acceptance`; non-loopback bind/CORS/frontend URL; any `sk_live_`/`rk_live_`/`pk_live_` value; a non-test Stripe key; a consent lifetime other than 1,800,000 ms; a missing or invalid authority.

Trust domain: authority `bookly-local-acceptance-NONPRODUCTION`, per-installation host ID, boot ID and 32-byte key in `local-acceptance/authority/` (outside both repos). The shipped `requireConsentHostVerificationProfile` denies every identity, so evidence sealed here never verifies in production (`tests/unit/local-acceptance-authority-isolation.test.ts`).

This folder is outside `tsconfig` `include` (`src/**`) and the Dockerfile copies only `src`, so it is never in `dist` or the image.
