// biome-ignore-all lint/suspicious/noConsole: local acceptance CLI prints operator-facing status
/** Creates the per-installation LOCAL ACCEPTANCE authority identity + key (NON-PRODUCTION).
 * Usage: node --import tsx dev/local-acceptance/init-authority.ts <authorityDir>
 * Refuses to overwrite an existing authority (old local certificates must stay verifiable). */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { LOCAL_AUTHORITY_ID } from "./authority.js";

const dir = resolve(process.argv[2] ?? "");
if (!process.argv[2] || basename(dirname(dir)) !== "local-acceptance")
  throw Error(
    "Pass the authority directory inside local-acceptance (e.g. ../local-acceptance/authority)",
  );
if (existsSync(join(dir, "authority.key"))) {
  console.log("Local acceptance authority already exists; not overwritten.");
  process.exit(0);
}
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, "identity.json"),
  JSON.stringify(
    {
      label: LOCAL_AUTHORITY_ID,
      installationId: randomBytes(16).toString("hex"),
      bootId: randomUUID(),
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
writeFileSync(join(dir, "authority.key"), randomBytes(32).toString("hex"), { mode: 0o600 });
console.log(`Created NON-PRODUCTION local acceptance authority in ${dir} (key not printed).`);
