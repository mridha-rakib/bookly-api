import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import {
  computeArtifactSha256,
  FIRST_CLASS_AUTHORITY_DIRECTORY,
  readProtectedAuthorityFile,
} from "../../../src/modules/booking/trusted-time/protected-authority-files.js";
import {
  adoptRelease,
  checkClock,
  initSigningKey,
  measureHostForQualification,
  measureRelease,
  readStatus,
  renewAttestation,
  resumeCheckout,
  revokeApprovalKey,
  stopCheckout,
  type ToolEnv,
} from "./authority.js";
import {
  AuthorityToolError,
  refuse,
  TOOL_CONFIG_DIRECTORY,
  TOOL_STATE_DIRECTORY,
} from "./contract.js";
import { type HostIo, readBootId } from "./host.js";

const MAX_INPUT_BYTES = 262144;

const rootControlled = (stat: Stats) =>
  stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0;

/** Every component from `/` must be a root-owned directory nobody else can write. */
function assertRootControlledChain(path: string, privateLeaf: boolean) {
  const parts = path.split("/").filter(Boolean);
  for (let i = 0; i <= parts.length; i++) {
    const component = `/${parts.slice(0, i).join("/")}`;
    let stat: Stats;
    try {
      stat = lstatSync(component);
    } catch {
      return refuse("DIRECTORY_MISSING", `${component} does not exist (see the handoff)`);
    }
    if (!rootControlled(stat)) refuse("DIRECTORY_UNSAFE", `${component} is not root-controlled`);
    if (privateLeaf && i === parts.length && (stat.mode & 0o077) !== 0)
      refuse("DIRECTORY_UNSAFE", `${component} must be mode 0700`);
  }
}

/** The only real host: fixed absolute executables, no shell, minimal fixed environment. */
const linuxHost: HostIo = Object.freeze({
  readFile(path: string) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw Error("not a regular file");
    return readFileSync(path);
  },
  listRegularFiles(path: string) {
    if (!existsSync(path)) return undefined;
    const names = readdirSync(path).sort();
    for (const name of names) {
      const stat = lstatSync(`${path}/${name}`);
      if (stat.isSymbolicLink() || !stat.isFile()) throw Error("unexpected entry");
    }
    return names;
  },
  exec(file: string, args: readonly string[], timeoutMs: number) {
    return new Promise<{ stdout: string; exitCode: number }>((resolve, reject) => {
      execFile(
        file,
        [...args],
        {
          timeout: timeoutMs,
          maxBuffer: 1048576,
          shell: false,
          env: { LC_ALL: "C", PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
        },
        (error, stdout) => {
          if (error && typeof error.code !== "number") reject(error);
          else resolve({ stdout: String(stdout), exitCode: error ? Number(error.code) : 0 });
        },
      );
    });
  },
  wallMs: () => Date.now(),
  monotonicNs: () => process.hrtime.bigint(),
});

const shippedEnv: ToolEnv = Object.freeze({
  configDirectory: TOOL_CONFIG_DIRECTORY,
  stateDirectory: TOOL_STATE_DIRECTORY,
  authorityDirectory: FIRST_CLASS_AUTHORITY_DIRECTORY,
  host: linuxHost,
  readConfig: (name: string) => readProtectedAuthorityFile(TOOL_CONFIG_DIRECTORY, name),
  assertPrivateState: () => assertRootControlledChain(TOOL_STATE_DIRECTORY, true),
  requireRootOwnedArtifact: true,
  localPath: (path: string) => path,
});

const USAGE = `usage: bookly-first-class-authority <command>
  status
  measure-host --profile <draft-profile.json>
  measure-release --source <root-owned checkout> --release-sha <40-hex>
  check-clock
  init-signing-key [--rotate]
  adopt-release --record <release-record.json> --signature <release-record.sig> --source <checkout> [--genesis]
  renew
  stop --reason <text>
  resume
  revoke-approval-key <sha256> --reference <decision reference>`;

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) refuse("USAGE", `${name} needs a value`);
  return value;
}
const required = (args: readonly string[], name: string) =>
  option(args, name) ?? refuse("USAGE", `${name} is required`);

/** Operator input file (record, signature, draft profile): regular, bounded, not a symlink. */
function readInput(path: string): Buffer {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_INPUT_BYTES)
    refuse("USAGE", `${path} must be a regular file under 256 KiB`);
  return readFileSync(path);
}

export async function runCli(argv: readonly string[], env: ToolEnv = shippedEnv): Promise<unknown> {
  if (process.platform !== "linux") refuse("UNSUPPORTED_PLATFORM", "Linux only");
  if (process.getuid?.() !== 0) refuse("ROOT_REQUIRED", "run as root");
  const [command, ...args] = argv;
  if (command !== "status" && command !== "measure-host" && command !== "measure-release")
    assertRootControlledChain(env.authorityDirectory, false);
  switch (command) {
    case "status": {
      env.assertPrivateState();
      let observed: { bootId: string; artifactSha256: string } | undefined;
      try {
        const deployment = JSON.parse(env.readConfig("deployment.json").toString("utf8"));
        observed = {
          bootId: readBootId(env.host),
          artifactSha256: computeArtifactSha256(env.localPath(String(deployment.apiRoot)), {
            requireRootOwned: env.requireRootOwnedArtifact,
          }),
        };
      } catch {
        observed = undefined;
      }
      return readStatus(env, observed);
    }
    case "measure-host":
      return measureHostForQualification(
        env,
        JSON.parse(readInput(required(args, "--profile")).toString("utf8")),
      );
    case "measure-release":
      return measureRelease(env, required(args, "--source"), required(args, "--release-sha"));
    case "check-clock":
      return checkClock(env);
    case "init-signing-key":
      return initSigningKey(env, args.includes("--rotate"));
    case "adopt-release":
      env.assertPrivateState();
      return adoptRelease(env, {
        record: readInput(required(args, "--record")),
        signature: readInput(required(args, "--signature")),
        sourceCheckout: required(args, "--source"),
        genesis: args.includes("--genesis"),
      });
    case "renew":
      env.assertPrivateState();
      return renewAttestation(env);
    case "stop":
      return stopCheckout(env, required(args, "--reason"), env.host.wallMs());
    case "resume":
      return resumeCheckout(env);
    case "revoke-approval-key":
      return revokeApprovalKey(
        env,
        args[0] ?? "",
        required(args, "--reference"),
        env.host.wallMs(),
      );
    default:
      return refuse("USAGE", USAGE);
  }
}

/** Entry point: JSON result on stdout, `CODE: message` on stderr, exit 1 on any refusal. */
export async function main(argv: readonly string[]) {
  try {
    const result = await runCli(argv);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message =
      error instanceof AuthorityToolError ? error.message : "INTERNAL: operation failed (denied)";
    process.stderr.write(`${message}\n`);
    return 1;
  }
}
