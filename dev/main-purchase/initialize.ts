// biome-ignore-all lint/suspicious/noConsole: explicit development installation CLI
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { authorityDirectory, loadMainConfiguration } from "./configuration.js";
import { CONTRACT, fingerprint, installationSchema, validateEnvironment } from "./guards.js";

if (!process.argv.includes("--approved-existing-development-data"))
  throw Error("Explicit existing development-data approval required");
const environment = loadMainConfiguration();
validateEnvironment(environment);
// Exclusive creation never replaces existing keys, bindings or history. No Mongo/provider writes.
mkdirSync(dirname(authorityDirectory), { recursive: true, mode: 0o700 });
mkdirSync(authorityDirectory, { recursive: false, mode: 0o700 });
const installation = installationSchema.parse({
  contract: CONTRACT,
  installationId: randomUUID(),
  developmentDataApproved: true,
  databaseFingerprint: fingerprint(environment["MONGODB_URI"] ?? ""),
  stripeSecretFingerprint: fingerprint(environment["STRIPE_SECRET_KEY"] ?? ""),
  stripePublishableFingerprint: fingerprint(environment["STRIPE_PUBLISHABLE_KEY"] ?? ""),
});
for (const [name, contents] of [
  ["signing.key", randomBytes(32).toString("hex")],
  ["installation.json", JSON.stringify(installation, null, 2)],
] as const) {
  const fd = openSync(join(authorityDirectory, name), "wx", 0o600);
  try {
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
console.info(
  "Installed the DEVELOPMENT-ONLY host-clock authority for the pinned existing database and Stripe TEST keys. No qualified UTC claim. Preserve this private directory for historical verification.",
);
