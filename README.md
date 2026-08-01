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

## Endpoints

- `GET /health`: liveness check. Does not require a database query.
- `GET /api/v1/health`: readiness check. Reports MongoDB connection state and returns `503` when not ready.
- `GET /docs`: Swagger UI, when docs are enabled.
- `GET /openapi.json`: generated OpenAPI document, when docs are enabled.

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

## PM2

```bash
pnpm build
pm2 start ecosystem.config.cjs
pm2 reload bookly-api
pm2 stop bookly-api
```

PM2 runs `dist/app/server.js` and is intended for non-Docker production deployments.
