import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { CONTRACT, fingerprint } from "./guards.js";

export const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const authorityDirectory = resolve(apiRoot, "tmp/main-development-purchase-authority");
export function requireDevelopmentContract(environment: Record<string, string | undefined>) {
  if (environment["NODE_ENV"] !== "development")
    throw Error("Main purchase authority is development-only");
  // The dedicated main-purchase development entry point is the explicit opt-in. Preserve an
  // explicitly supplied value so mistakes or attempts to disable the contract fail closed.
  if (environment["BOOKLY_MAIN_PURCHASE_CONTRACT"] === undefined)
    environment["BOOKLY_MAIN_PURCHASE_CONTRACT"] = CONTRACT;
  if (environment["BOOKLY_MAIN_PURCHASE_CONTRACT"] !== CONTRACT)
    throw Error(`Invalid BOOKLY_MAIN_PURCHASE_CONTRACT; expected ${CONTRACT}`);
}
// Exact existing connection covered by the Owner's development-data approval. A new URI is
// a different authority installation decision, never something initialize.ts auto-adopts.
const approvedMainDatabaseFingerprint =
  "5f618977ae03e95a7e7bca29577d3b4bbe2e061034993d3b73a1c3737b0836c3";
export function loadMainConfiguration() {
  // The main API .env is the only file loaded. Inherited process values still take precedence.
  if (
    process.env["DOTENV_CONFIG_PATH"] &&
    resolve(process.env["DOTENV_CONFIG_PATH"]) !== resolve(apiRoot, ".env")
  )
    throw Error("Main development purchase requires the existing main API configuration");
  config({ path: resolve(apiRoot, ".env"), quiet: true });
  process.env["DOTENV_CONFIG_PATH"] = resolve(apiRoot, ".env");
  requireDevelopmentContract(process.env);
  if (fingerprint(process.env["MONGODB_URI"] ?? "") !== approvedMainDatabaseFingerprint)
    throw Error(
      "Database differs from the existing main development database approved by the Owner",
    );
  // Explicit development composition binds the main API to loopback, without changing .env.
  process.env["HTTP_BIND_HOST"] ??= "127.0.0.1";
  process.env["PACKAGE_CONSENT_QUOTE_LIFETIME_MS"] ??= "1800000";
  return process.env;
}
