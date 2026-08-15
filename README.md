# Bookly API

Production-grade backend foundation for Bookly.

## Requirements

- Node.js 24 LTS
- pnpm 11.17.0
- External MongoDB connection string
- Docker, optional for container builds
- PM2, optional for non-Docker production process management

Node version is pinned via `.nvmrc` and `.node-version` (both `24`), matching `package.json#engines`
and the Dockerfile base image. Use your version manager of choice (nvm, fnm, volta, asdf) to pick it up.

## Setup

```bash
pnpm install
cp .env.example .env
```

Set `MONGODB_URI` to an external MongoDB URI. Do not commit real credentials.

## Scripts

```bash
pnpm dev
pnpm typecheck
pnpm check
pnpm check:fix
pnpm format
pnpm test
pnpm test:coverage
pnpm build
pnpm start
pnpm seed:super-admin
```

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `NODE_ENV` | No | `development`, `test`, or `production`. |
| `PORT` | No | HTTP port. Defaults to `3000`. |
| `APP_NAME` | No | Safe application display name. |
| `API_VERSION` | No | API version prefix, for example `v1`. |
| `MONGODB_URI` | Yes outside tests | External `mongodb://` or `mongodb+srv://` URI. |
| `LOG_LEVEL` | No | Pino log level. |
| `CORS_ORIGINS` | No | Comma-separated allowed origins. Wildcard is blocked in production. |
| `RATE_LIMIT_WINDOW_MS` | No | API rate-limit window in milliseconds. |
| `RATE_LIMIT_MAX` | No | Maximum API requests per window. |
| `API_DOCS_ENABLED` | No | Enables `/docs` and `/openapi.json`. Defaults off in production. |
| `TRUST_PROXY` | No | Enables Express trust proxy. |
| `SHUTDOWN_TIMEOUT_MS` | No | Graceful shutdown timeout. |
| `JWT_ACCESS_TOKEN_SECRET` | Yes in production | HS256 signing secret, minimum 32 characters. Local development has an unsafe default. |
| `JWT_ACCESS_TOKEN_TTL_MINUTES` | No | Access-token lifetime. Defaults to 15 minutes. |
| `REFRESH_TOKEN_TTL_DAYS` | No | Refresh-session lifetime and cookie max age. Defaults to 30 days. |
| `AUTH_COOKIE_NAME` | No | Refresh cookie name. |
| `AUTH_COOKIE_DOMAIN` | Deployment-specific | Optional cookie domain. Leave blank for host-only local cookies. |
| `AUTH_COOKIE_PATH` | No | Refresh cookie path. Defaults to `/api/v1/auth`. |
| `AUTH_COOKIE_SECURE` | Yes in production | Must be true in production deployments. |
| `AUTH_COOKIE_SAME_SITE` | No | `lax`, `strict`, or `none`. Use `none` only with secure cross-site deployments. |
| `OTP_LENGTH` | No | Fixed at 4 for the current frontend. |
| `OTP_EXPIRY_MINUTES` | No | Email OTP expiry. Defaults to 10 minutes. |
| `OTP_RESEND_COOLDOWN_SECONDS` | No | OTP resend cooldown. Defaults to 60 seconds. |
| `OTP_MAX_VERIFICATION_ATTEMPTS` | No | Maximum OTP verification attempts. Defaults to 5. |
| `OTP_MAX_RESENDS_PER_HOUR` | No | Maximum OTP sends per rolling hour. Defaults to 5. |
| `OTP_HASH_SECRET` | Yes in production | Secret used to hash locally generated email OTPs. |
| `REGISTRATION_SESSION_TTL_HOURS` | No | TTL for abandoned registration sessions. Defaults to 24 hours. |
| `RESEND_API_KEY` | Required for email OTP delivery | Resend API key. Not required to boot locally; provider calls fail with `PROVIDER_NOT_CONFIGURED` when missing. |
| `RESEND_FROM_EMAIL` | Required for email OTP delivery | Verified sender email for Resend. |
| `RESEND_FROM_NAME` | Required for email OTP delivery | Sender display name for Resend. |
| `TWILIO_ACCOUNT_SID` | Required for phone OTP delivery | Twilio account SID. |
| `TWILIO_AUTH_TOKEN` | Required for phone OTP delivery | Twilio auth token. |
| `TWILIO_VERIFY_SERVICE_SID` | Required for phone OTP delivery | Twilio Verify service SID configured for the 4-digit frontend contract. |
| `SUPER_ADMIN_EMAIL` | Required for seed command | Email for `pnpm seed:super-admin`. |
| `SUPER_ADMIN_PASSWORD` | Required for seed command | Initial Super Admin password. Never logged. |
| `SUPER_ADMIN_FIRST_NAME` | Required for seed command | Super Admin profile first name. |
| `SUPER_ADMIN_LAST_NAME` | Required for seed command | Super Admin profile last name. |
| `ARGON2_MEMORY_COST` | No | Argon2id memory cost. Defaults to 65536. |
| `ARGON2_TIME_COST` | No | Argon2id time cost. Defaults to 3. |
| `ARGON2_PARALLELISM` | No | Argon2id parallelism. Defaults to 1. |
| `AUTH_ENTRY_RATE_LIMIT_MAX` | No | Entry/account lookup requests per 15 minutes. |
| `AUTH_LOGIN_RATE_LIMIT_MAX` | No | Login requests per 15 minutes. |
| `AUTH_OTP_SEND_RATE_LIMIT_MAX` | No | OTP send requests per hour. |
| `AUTH_OTP_VERIFY_RATE_LIMIT_MAX` | No | OTP verify requests per 15 minutes. |
| `AUTH_REFRESH_RATE_LIMIT_MAX` | No | Refresh requests per 15 minutes. |
| `STORAGE_PROVIDER` | No | Storage backend selector. Currently `s3`. |
| `S3_ENDPOINT` | Required for business media | S3-compatible endpoint, for example local MinIO or a future object-storage provider endpoint. |
| `S3_REGION` | No | S3-compatible region. Defaults to `us-east-1` for local MinIO. |
| `S3_BUCKET` | Required for business media | Bucket for business media object data. |
| `S3_ACCESS_KEY_ID` | Required for business media | S3-compatible access key. Never expose to browser code. |
| `S3_SECRET_ACCESS_KEY` | Required for business media | S3-compatible secret key. Never expose to browser code. |
| `S3_FORCE_PATH_STYLE` | No | Use path-style addressing. Defaults to `true` for local MinIO. |
| `S3_PUBLIC_BASE_URL` | No | Optional public object base URL. Leave blank to return signed read URLs. |
| `BUSINESS_MEDIA_MAX_UPLOAD_BYTES` | No | Maximum image upload size. Defaults to `5242880` bytes. |
| `BUSINESS_MEDIA_SIGNED_URL_TTL_SECONDS` | No | Signed read URL lifetime. Defaults to `900` seconds. |

## Endpoints

- `GET /health`: liveness check. Does not require a database query.
- `GET /api/v1/health`: readiness check. Reports MongoDB connection state and returns `503` when not ready.
- `GET /docs`: Swagger UI, when docs are enabled.
- `GET /openapi.json`: generated OpenAPI document, when docs are enabled.

### Authentication

Core auth is mounted under `/api/v1/auth`.

- Customer portal: `POST /customer/entry`, `POST /customer/login`, and `/customer/register/*`.
- Professional portal: `POST /professional/entry`, `POST /professional/login`, and `/professional/register/*`.
- Super Admin portal: `POST /super-admin/login`; public Super Admin signup is intentionally absent.
- Common session endpoints: `POST /refresh`, `POST /logout`, `GET /me`.

Access tokens are returned in JSON for `Authorization: Bearer` usage. Refresh tokens are opaque,
stored only as hashes server-side, and sent only in an HttpOnly cookie. Refresh rotates the cookie on
each successful call.

Email OTP uses Resend and phone OTP uses Twilio Verify. Missing provider credentials do not create a
development bypass; provider-backed OTP endpoints fail with `PROVIDER_NOT_CONFIGURED`.

## Architecture

The foundation uses a module-based, class-oriented flow:

```text
Route -> Validation middleware -> Controller -> Service -> Repository -> Mongoose/database state
```

Current folder structure:

```text
src/
  app/
  common/
  config/
  database/
  modules/health/
  modules/auth/
  modules/registration-session/
  modules/verification/
  modules/session/
  modules/user/
  modules/business-onboarding/
  modules/business/
  routes/
tests/
  helpers/
  integration/
  setup/
  unit/
```

Application construction is separated from process startup. Integration tests import the Express app
without opening a network port or connecting to production resources.

## pnpm Workspace File

`pnpm-workspace.yaml` exists only to declare pnpm's build-script allow policy (`allowBuilds`, required
so pnpm permits esbuild's postinstall script). It does not declare a `packages` list. This backend is a
single-package repository, not a monorepo — do not add workspace packages here.

## Docker

```bash
docker build -t bookly-api .
docker run --rm -p 3000:3000 --env-file .env bookly-api
```

The Docker image uses a multi-stage Debian-based Node.js 24 build, installs production-only runtime
dependencies, runs compiled TypeScript output, uses the non-root `node` user, and checks `GET /health`.

Husky is a devDependency, so it is intentionally absent from the production-only dependency install.
The `prepare` script calls `scripts/prepare-husky.mjs` instead of `husky` directly: it exits
successfully without importing husky when `HUSKY=0` is set or when no `.git` directory is present, and
otherwise runs husky's real setup and fails loudly if that setup genuinely errors. The Dockerfile sets
`HUSKY=0` for its dependency-install stages so `pnpm install` never tries to invoke husky.

### Local MinIO for Business Media

From the repository root:

```bash
cp .env.example .env
docker compose up -d minio
```

Set the API `.env` storage variables to point at MinIO:

```bash
STORAGE_PROVIDER=s3
S3_ENDPOINT=http://127.0.0.1:9000
S3_REGION=us-east-1
S3_BUCKET=bookly-business-media
S3_ACCESS_KEY_ID=<same value as MINIO_ROOT_USER locally, or a dedicated MinIO access key>
S3_SECRET_ACCESS_KEY=<same value as MINIO_ROOT_PASSWORD locally, or a dedicated MinIO secret key>
S3_FORCE_PATH_STYLE=true
S3_PUBLIC_BASE_URL=
```

The API bootstraps the configured bucket idempotently at startup when storage configuration is present.
Object data is stored in the `bookly-minio-data` Docker volume and survives container restarts.

For a future S3-compatible provider such as Hetzner Object Storage, keep `STORAGE_PROVIDER=s3` and
change only the endpoint, region, bucket, credentials, and path-style/public URL settings required by
that provider.

## PM2

```bash
pnpm build
pm2 start ecosystem.config.cjs
pm2 reload bookly-api
pm2 stop bookly-api
```

PM2 runs `dist/app/server.js` and is intended for non-Docker production deployments.
