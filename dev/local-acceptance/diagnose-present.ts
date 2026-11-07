// biome-ignore-all lint/suspicious/noConsole: local acceptance CLI prints operator-facing status
/** BC-F05C diagnostic (local acceptance only): re-runs PackageCheckoutAcceptanceService.present
 * for one operation and prints the exact internal conflict message the HTTP layer maps to 409.
 * Usage: BOOKLY_DIAG_TOKEN=<bearer> node --import tsx --import ./dev/local-acceptance/register.mjs \
 *   dev/local-acceptance/diagnose-present.ts <businessId> <customerUserId> <operationId> */
import { resolve } from "node:path";
import { Types } from "mongoose";
import { assertLocalAcceptanceEnvironment } from "./guards.js";

await import("dotenv/config");
assertLocalAcceptanceEnvironment(process.env, { apiRoot: resolve(".") });
const { loadLocalAuthority, markLocalAcceptanceComposed } = await import("./authority.js");
markLocalAcceptanceComposed(
  loadLocalAuthority(process.env["BOOKLY_LOCAL_ACCEPTANCE_AUTHORITY_DIR"] as string),
);
const { DatabaseManager } = await import("../../src/database/database-manager.js");
const { buildPackageConsentServices } = await import(
  "../../src/modules/booking/package-consent.factory.js"
);
const { packageConsentOperationKey } = await import(
  "../../src/modules/booking/package-consent.route.js"
);
const db = new DatabaseManager();
await db.connect();
const [businessId, userId, operationId] = process.argv.slice(2) as [string, string, string];
const s = buildPackageConsentServices(1_800_000);
try {
  await s.acceptance.present(
    `Bearer ${process.env["BOOKLY_DIAG_TOKEN"]}`,
    new Types.ObjectId(businessId),
    packageConsentOperationKey(new Types.ObjectId(userId), operationId),
  );
  console.log("present() succeeded");
} catch (error) {
  console.log("present() failed:", (error as Error).name, "-", (error as Error).message);
  console.log(((error as Error).stack ?? "").split("\n").slice(1, 6).join("\n"));
}
await db.disconnect();
