/** BC-F05C local acceptance composition — startup refusal rules (NON-PRODUCTION ONLY).
 * Pure: reads only the supplied environment record. Every rule fails closed. */
import { basename, dirname, resolve } from "node:path";

export const LOCAL_ACCEPTANCE_DATABASE = "bookly_local_acceptance";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class LocalAcceptanceRefusal extends Error {
  public constructor(reason: string) {
    super(`Local acceptance composition refused: ${reason}`);
    this.name = "LocalAcceptanceRefusal";
  }
}

const loopbackUrl = (value: string | undefined, name: string, required: boolean) => {
  if (!value) {
    if (required) throw new LocalAcceptanceRefusal(`${name} is required`);
    return;
  }
  for (const part of value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)) {
    let url: URL;
    try {
      url = new URL(part);
    } catch {
      throw new LocalAcceptanceRefusal(`${name} is not a URL`);
    }
    if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname))
      throw new LocalAcceptanceRefusal(`${name} must be a loopback http URL`);
  }
};

/** Returns the validated database name. Never logs the URI. */
export function assertLoopbackMongoUri(uri: string | undefined): string {
  if (!uri) throw new LocalAcceptanceRefusal("MONGODB_URI is required");
  if (!uri.startsWith("mongodb://"))
    throw new LocalAcceptanceRefusal("MONGODB_URI must use mongodb:// (SRV/remote is rejected)");
  const rest = uri.slice("mongodb://".length);
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  if (authority.includes("@"))
    throw new LocalAcceptanceRefusal("MONGODB_URI must not carry credentials");
  const hosts = authority.split(",").map((h) => h.replace(/:\d+$/, ""));
  if (!hosts.length || hosts.some((h) => !LOOPBACK_HOSTS.has(h)))
    throw new LocalAcceptanceRefusal("MONGODB_URI hosts must all be loopback");
  const database = slash === -1 ? "" : (rest.slice(slash + 1).split("?")[0] ?? "");
  if (database !== LOCAL_ACCEPTANCE_DATABASE)
    throw new LocalAcceptanceRefusal(`MONGODB_URI database must be ${LOCAL_ACCEPTANCE_DATABASE}`);
  return database;
}

/** Must run BEFORE dotenv is imported, so the operational api/.env is never even read. */
export function assertLocalAcceptanceEnvFile(
  env: Record<string, string | undefined>,
  options: { apiRoot: string },
): void {
  const dotenvPath = env["DOTENV_CONFIG_PATH"];
  if (!dotenvPath)
    throw new LocalAcceptanceRefusal("DOTENV_CONFIG_PATH must name the local acceptance env file");
  const resolved = resolve(dotenvPath);
  if (resolved === resolve(options.apiRoot, ".env") || basename(resolved) === ".env")
    throw new LocalAcceptanceRefusal("the operational api/.env file must never be loaded");
  if (basename(dirname(resolved)) !== "local-acceptance")
    throw new LocalAcceptanceRefusal(
      "DOTENV_CONFIG_PATH must be inside a local-acceptance directory",
    );
}

export function assertLocalAcceptanceEnvironment(
  env: Record<string, string | undefined>,
  options: { apiRoot: string },
): void {
  assertLocalAcceptanceEnvFile(env, options);
  if (env["NODE_ENV"] !== "development")
    throw new LocalAcceptanceRefusal("NODE_ENV must be development");
  assertLoopbackMongoUri(env["MONGODB_URI"]);
  const bind = env["HTTP_BIND_HOST"];
  if (!bind || !LOOPBACK_HOSTS.has(bind))
    throw new LocalAcceptanceRefusal("HTTP_BIND_HOST must be a loopback address");
  loopbackUrl(env["CORS_ORIGINS"], "CORS_ORIGINS", true);
  loopbackUrl(env["PUBLIC_API_BASE_URL"], "PUBLIC_API_BASE_URL", false);
  loopbackUrl(env["FRONTEND_BASE_URL"], "FRONTEND_BASE_URL", true);
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (/^(sk|rk|pk)_live_/.test(value.trim()))
      throw new LocalAcceptanceRefusal(`${key} holds a live payment credential`);
  }
  const secret = env["STRIPE_SECRET_KEY"];
  if (secret && !secret.startsWith("sk_test_"))
    throw new LocalAcceptanceRefusal("STRIPE_SECRET_KEY must be a test-mode key when present");
  const publishable = env["STRIPE_PUBLISHABLE_KEY"];
  if (publishable && !publishable.startsWith("pk_test_"))
    throw new LocalAcceptanceRefusal("STRIPE_PUBLISHABLE_KEY must be a test-mode key when present");
  const life = env["PACKAGE_CONSENT_QUOTE_LIFETIME_MS"];
  if (life !== undefined && life !== "" && life !== "1800000")
    throw new LocalAcceptanceRefusal("the consent lifetime must remain exactly 1800000 ms");
  if (!env["BOOKLY_LOCAL_ACCEPTANCE_AUTHORITY_DIR"])
    throw new LocalAcceptanceRefusal("BOOKLY_LOCAL_ACCEPTANCE_AUTHORITY_DIR is required");
}
