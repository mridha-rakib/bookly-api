import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { z } from "zod";
import { releaseRegistryEntrySchema } from "../../../src/modules/booking/trusted-time/authenticated-release-record.js";
import { refuse, STATE_FILES } from "./contract.js";

const TEMP = /^\.[a-z0-9.-]+\.[0-9]+\.[a-f0-9]{16}\.tmp$/;

const fsyncDirectory = (directory: string) => {
  // Directory fsync makes the rename durable on Linux; Windows (tests only) cannot open one.
  if (process.platform === "win32") return;
  const fd = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

/** Crash-safe replace: exclusive temp file in the same directory, fsync, rename, directory
 * fsync. A reader sees either the old or the new complete file, never a partial one. */
export function writeFileAtomic(directory: string, name: string, data: Buffer, mode: number) {
  const temp = `${directory}/.${name}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  try {
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temp);
    throw error;
  }
  closeSync(fd);
  renameSync(temp, `${directory}/${name}`);
  fsyncDirectory(directory);
}

export function removeFileDurably(directory: string, name: string) {
  if (!existsSync(`${directory}/${name}`)) return;
  unlinkSync(`${directory}/${name}`);
  fsyncDirectory(directory);
}

/** Removes temp files left by an interrupted write (only the tool's own naming pattern). */
export function removeStaleTemporaryFiles(directory: string) {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory))
    if (TEMP.test(name) && lstatSync(`${directory}/${name}`).isFile())
      unlinkSync(`${directory}/${name}`);
}

export function ensureDirectory(path: string, mode: number) {
  if (!existsSync(path)) mkdirSync(path, { mode });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    refuse("STATE_UNSAFE", "state path is not a directory");
}

/** Single-operator exclusion. A leftover lock (crash) blocks mutation until an operator
 * inspects state and removes it: interrupted operations never resume silently. */
export async function withLock<T>(stateDirectory: string, run: () => Promise<T>): Promise<T> {
  const path = `${stateDirectory}/${STATE_FILES.lock}`;
  let fd: number;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch {
    return refuse("OPERATION_LOCKED", `${path} exists; inspect state, then remove it`);
  }
  writeSync(fd, `${process.pid}\n`);
  fsyncSync(fd);
  closeSync(fd);
  try {
    return await run();
  } finally {
    removeFileDurably(stateDirectory, STATE_FILES.lock);
  }
}

const readJson = <T>(path: string, schema: z.ZodType<T>, fallback: T): T => {
  if (!existsSync(path)) return fallback;
  try {
    return schema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return refuse("STATE_CORRUPT", `${path} is unreadable; restore it from the protected backup`);
  }
};
const writeJson = (directory: string, name: string, value: unknown) =>
  writeFileAtomic(directory, name, Buffer.from(`${JSON.stringify(value)}\n`), 0o600);

const sha = z.string().regex(/^[a-f0-9]{64}$/);

const sequenceSchema = z
  .object({ version: z.literal(1), highestSequence: z.number().int().safe().nonnegative() })
  .strict();
export const readHighestSequence = (dir: string) =>
  readJson(`${dir}/${STATE_FILES.sequence}`, sequenceSchema, { version: 1, highestSequence: 0 })
    .highestSequence;
/** Durably reserves the next sequence BEFORE anything is signed, so a crash between reserve
 * and publish skips a number but never reuses one. */
export function reserveSequence(dir: string, publishedSequence: number) {
  const next = Math.max(readHighestSequence(dir), publishedSequence) + 1;
  if (!Number.isSafeInteger(next)) refuse("SEQUENCE_EXHAUSTED", "sequence overflow");
  writeJson(dir, STATE_FILES.sequence, { version: 1, highestSequence: next });
  return next;
}

/** Records a sequence seen elsewhere (e.g. a published attestation being withdrawn). */
export function recordSequenceAtLeast(dir: string, sequence: number) {
  if (Number.isSafeInteger(sequence) && sequence > readHighestSequence(dir))
    writeJson(dir, STATE_FILES.sequence, { version: 1, highestSequence: sequence });
}

const historySchema = z
  .object({
    version: z.literal(1),
    releases: z.array(
      z
        .object({
          recordSha256: sha,
          approvalReference: z.string(),
          releaseSha: z.string().regex(/^[a-f0-9]{40}$/),
          previousEntries: z.array(releaseRegistryEntrySchema),
          entries: z.array(releaseRegistryEntrySchema).min(1),
          adoptedAtMs: z.number().int().safe(),
        })
        .strict(),
    ),
  })
  .strict();
export type RegistryHistory = z.infer<typeof historySchema>;
export const readHistory = (dir: string): RegistryHistory =>
  readJson(`${dir}/${STATE_FILES.history}`, historySchema, { version: 1, releases: [] });
/** Append-only: the new history must extend the stored one exactly. */
export function appendHistory(dir: string, entry: RegistryHistory["releases"][number]) {
  const history = readHistory(dir);
  writeJson(dir, STATE_FILES.history, { version: 1, releases: [...history.releases, entry] });
}

const revocationSchema = z
  .object({
    version: z.literal(1),
    revoked: z.array(
      z
        .object({ approvalKeySha256: sha, reference: z.string().min(1).max(256), atMs: z.number() })
        .strict(),
    ),
  })
  .strict();
export const readRevocations = (dir: string) =>
  readJson(`${dir}/${STATE_FILES.revocations}`, revocationSchema, { version: 1, revoked: [] });
export function appendRevocation(
  dir: string,
  approvalKeySha256: string,
  reference: string,
  atMs: number,
) {
  const current = readRevocations(dir);
  if (current.revoked.some((r) => r.approvalKeySha256 === approvalKeySha256)) return;
  writeJson(dir, STATE_FILES.revocations, {
    version: 1,
    revoked: [...current.revoked, { approvalKeySha256, reference, atMs }],
  });
}

const adoptedSchema = z
  .object({
    version: z.literal(1),
    recordSha256: sha,
    gitSha: z.string().regex(/^[a-f0-9]{40}$/),
    artifactSha256: sha,
    dependencySha256: sha,
    approvalKeySha256: sha,
    adoptedAtMs: z.number().int().safe(),
  })
  .strict();
export type AdoptedRelease = z.infer<typeof adoptedSchema>;
export const readAdopted = (dir: string): AdoptedRelease | undefined =>
  readJson<AdoptedRelease | undefined>(`${dir}/${STATE_FILES.adopted}`, adoptedSchema, undefined);
export const writeAdopted = (dir: string, value: AdoptedRelease) =>
  writeJson(dir, STATE_FILES.adopted, value);

const stoppedSchema = z
  .object({ version: z.literal(1), atMs: z.number(), reason: z.string().max(512) })
  .strict();
export const readStopped = (dir: string) =>
  readJson<z.infer<typeof stoppedSchema> | undefined>(
    `${dir}/${STATE_FILES.stopped}`,
    stoppedSchema,
    undefined,
  );
export const writeStopped = (dir: string, atMs: number, reason: string) =>
  writeJson(dir, STATE_FILES.stopped, { version: 1, atMs, reason: reason.slice(0, 512) });
