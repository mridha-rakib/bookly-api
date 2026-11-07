// biome-ignore-all lint/suspicious/noConsole: local acceptance CLI prints operator-facing status
/** BC-F05C LOCAL ACCEPTANCE entry point — NON-PRODUCTION. Not part of src/dist.
 * node --import tsx --import ./dev/local-acceptance/register.mjs dev/local-acceptance/server.ts
 * Order: guards (before dotenv and before any app import) -> authority -> shipped bootstrap. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocalAcceptanceEnvFile, assertLocalAcceptanceEnvironment } from "./guards.js";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// The env-file path is checked before dotenv runs (api/.env is never read), then the merged
// environment is checked again, so neither source can introduce a remote/live target.
try {
  assertLocalAcceptanceEnvFile(process.env, { apiRoot });
} catch (error) {
  console.error((error as Error).message);
  process.exit(78);
}
await import("dotenv/config");
try {
  assertLocalAcceptanceEnvironment(process.env, { apiRoot });
} catch (error) {
  console.error((error as Error).message);
  process.exit(78);
}
const { loadLocalAuthority, markLocalAcceptanceComposed, LOCAL_AUTHORITY_ID } = await import(
  "./authority.js"
);
let host: ReturnType<typeof loadLocalAuthority>;
try {
  host = loadLocalAuthority(
    resolve(process.env["BOOKLY_LOCAL_ACCEPTANCE_AUTHORITY_DIR"] as string),
  );
} catch (error) {
  console.error((error as Error).message);
  process.exit(78);
}
const { validateConsentHostPolicy } = await import(
  "../../src/modules/booking/trusted-time/host-policy.js"
);
validateConsentHostPolicy(host);
markLocalAcceptanceComposed(host);
console.warn(
  `\n*** BOOKLY LOCAL ACCEPTANCE AUTHORITY (${LOCAL_AUTHORITY_ID}) — NON-PRODUCTION, LOW ASSURANCE ***\n` +
    "Consent evidence is sealed by a local key on an unauthenticated Windows clock and is NOT production-qualified.\n" +
    "Stripe/Calendar/notification providers are not substituted. Production entry points remain fail-closed.\n",
);
await import("../../src/app/server.js");
