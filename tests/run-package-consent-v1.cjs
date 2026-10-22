/* Test-only runner and inherited network preload. Never reads application .env. */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawnSync } = require("node:child_process");

if (process.env.BOOKLY_CONSENT_NETWORK_GUARD === "1") {
  const local = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0:0:0:0:0:0:0:1"]);
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host =
      first && typeof first === "object"
        ? first.host
        : typeof args[1] === "string"
          ? args[1]
          : undefined;
    if (host && !local.has(host)) throw new Error("Consent verification blocks nonlocal sockets");
    return connect.apply(this, args);
  };
  const fetch = globalThis.fetch;
  globalThis.fetch = (input, ...args) => {
    const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!local.has(target.hostname)) throw new Error("Consent verification blocks nonlocal fetch");
    return fetch(input, ...args);
  };
} else if (process.argv.includes("--help")) {
  process.stdout.write(
    "node tests/run-package-consent-v1.cjs [--next]\nDisposable create-only Mongo tests; --next additionally runs actual Next/Chrome with real test login. Requires installed Mongo 8.2.6, dependencies and Chrome; no downloads. Artifacts are retained in a unique temp directory.\n",
  );
} else {
  const api = path.resolve(__dirname, "..");
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "bookly-consent-v1-verify-"));
  const binary = path.join(
    os.homedir(),
    ".cache",
    "mongodb-binaries",
    "mongod-x64-win32-8.2.6.exe",
  );
  if (!fs.existsSync(binary))
    throw new Error("Installed local Mongo binary required; downloads disabled");
  fs.writeFileSync(path.join(artifacts, "empty.env"), "");
  const keep = new Set([
    "SYSTEMROOT",
    "WINDIR",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "COMSPEC",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => keep.has(key.toUpperCase())),
  );
  Object.assign(env, {
    NODE_ENV: "test",
    DOTENV_CONFIG_PATH: path.join(artifacts, "empty.env"),
    MONGODB_URI: "mongodb://127.0.0.1:1/unused_consent_test_application",
    MONGOMS_SYSTEM_BINARY: binary,
    MONGOMS_RUNTIME_DOWNLOAD: "false",
    MONGOMS_VERSION: "8.2.6",
    BOOKLY_CONSENT_NETWORK_GUARD: "1",
    NODE_OPTIONS: `--require="${__filename.replaceAll("\\", "/")}"`,
  });
  const tests = [
    "tests/integration/database/package-consent-errors.integration.test.ts",
    "tests/integration/database/package-consent-mongo-clock.integration.test.ts",
    "tests/integration/database/package-consent-boundaries.integration.test.ts",
    "tests/integration/database/package-consent-http.integration.test.ts",
    "tests/integration/database/package-checkout-acceptance.integration.test.ts",
    "tests/integration/database/package-checkout-retention.integration.test.ts",
    "tests/unit/package-consent-config.test.ts",
  ];
  if (process.argv.includes("--next")) {
    env.BOOKLY_CONSENT_NEXT_ARTIFACTS = artifacts;
    tests.push("tests/integration/database/package-consent-next.integration.test.ts");
  }
  const command = [
    "node_modules/vitest/vitest.mjs",
    "run",
    ...tests,
    "--pool=forks",
    "--fileParallelism=false",
  ];
  fs.writeFileSync(
    path.join(artifacts, "command.json"),
    JSON.stringify({ cwd: api, command, environmentKeys: Object.keys(env) }, null, 2),
  );
  const log = fs.openSync(path.join(artifacts, "verification.log"), "w");
  const result = spawnSync(process.execPath, command, {
    cwd: api,
    env,
    windowsHide: true,
    stdio: ["ignore", log, log],
    timeout: 900000,
  });
  fs.closeSync(log);
  process.stdout.write(fs.readFileSync(path.join(artifacts, "verification.log"), "utf8"));
  process.stdout.write(`Artifacts: ${artifacts}\n`);
  process.exitCode = result.status ?? 1;
}
