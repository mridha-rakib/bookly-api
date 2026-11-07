import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { hashCanonicalPackageCheckoutContent as digest } from "../../src/modules/booking/package-checkout-binding.js";
import type { HostObservation } from "../../src/modules/booking/trusted-time/host-clock.js";
import type { QualifiedConsentHost } from "../../src/modules/booking/trusted-time/qualified-host.js";
import { CONTRACT, installationSchema, validateEnvironment } from "./guards.js";

// Limits measure agreement between two local clock coordinates, NEVER UTC accuracy.
export const CLOCK_STEP_LIMIT_MS = 50;
export const MAX_MONITOR_GAP_MS = 5000;
const REFERENCE = "DEVELOPMENT-HOST-CLOCK-NO-UTC";
const VERSION = `${CONTRACT}:NO-QUALIFIED-UTC`;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const readingSchema = z
  .object({
    epoch: z.uuid(),
    anchorMs: z.number().int().safe().nonnegative(),
    elapsedMs: z.number().nonnegative(),
    wallMs: z.number().int().safe().nonnegative(),
  })
  .strict();
type Reading = z.infer<typeof readingSchema>;
const recordSchema = z
  .object({
    previous: z.string(),
    kind: z.enum(["EPOCH", "SAMPLE"]),
    reading: readingSchema,
    seal: hash,
  })
  .strict();
const signature = (key: Buffer, purpose: string, value: unknown) =>
  createHmac("sha256", key).update(`${CONTRACT}:${purpose}\0`).update(digest(value)).digest("hex");
const same = (a: string, b: string) =>
  /^[a-f0-9]{64}$/.test(a) &&
  /^[a-f0-9]{64}$/.test(b) &&
  timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

/** A host-relative clock. A discontinuity poisons the process; no re-anchor or validity extension.
 * Every issued sample is fsynced before use. Each restart has a fresh epoch, so partial consent
 * cannot acquire a new post-commit witness across restart. Already sealed pairs remain verifiable.
 * This key-holding development host is trusted; its administrator can forge local assertions. */
export class DevelopmentClock {
  private lastMono: number;
  private lastWall: number;
  private poisoned = false;
  private readonly originMono: number;
  private readonly anchorMs: number;
  private readonly epoch = randomUUID();
  private previous = "";
  private readonly epochs = new Map<string, number>();
  private readonly samples = new Set<string>();
  private readonly key: Buffer;
  private readonly installation;
  private readonly journal: string;
  private readonly lock: string;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    dir: string,
    private readonly environment: Record<string, string | undefined>,
    private readonly wall = () => Date.now(),
    private readonly mono = () => Number(process.hrtime.bigint()) / 1e6,
  ) {
    this.installation = installationSchema.parse(
      JSON.parse(readFileSync(join(dir, "installation.json"), "utf8")),
    );
    validateEnvironment(environment, this.installation);
    this.key = Buffer.from(readFileSync(join(dir, "signing.key"), "utf8").trim(), "hex");
    if (this.key.length !== 32) throw Error("Development signing key unavailable");
    this.journal = join(dir, "clock.journal");
    this.lock = join(dir, "runtime.lock");
    if (existsSync(this.lock)) {
      const pid = Number(readFileSync(this.lock, "utf8"));
      if (!Number.isSafeInteger(pid) || pid < 1) throw Error("Invalid development authority lock");
      try {
        process.kill(pid, 0);
        throw Error("Development authority is already running");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        unlinkSync(this.lock);
      }
    }
    writeFileSync(this.lock, String(process.pid), { flag: "wx", mode: 0o600 });
    try {
      let highWater = 0;
      if (existsSync(this.journal)) {
        const contents = readFileSync(this.journal, "utf8");
        if (!contents.endsWith("\n"))
          throw Error(
            "Incomplete development clock journal; retained evidence requires operator review",
          );
        for (const line of contents.trimEnd().split("\n")) {
          const row = recordSchema.parse(JSON.parse(line));
          const { seal, ...payload } = row;
          if (
            row.previous !== this.previous ||
            !same(seal, signature(this.key, "journal", payload))
          )
            throw Error("Development clock journal integrity failure");
          if (row.kind === "EPOCH") {
            if (
              this.epochs.has(row.reading.epoch) ||
              row.reading.elapsedMs !== 0 ||
              row.reading.anchorMs !== row.reading.wallMs ||
              row.reading.wallMs < highWater
            )
              throw Error("Invalid development epoch");
            this.epochs.set(row.reading.epoch, row.reading.anchorMs);
          } else if (this.epochs.get(row.reading.epoch) !== row.reading.anchorMs)
            throw Error("Unknown development epoch");
          highWater = Math.max(
            highWater,
            row.reading.wallMs,
            Math.ceil(row.reading.anchorMs + row.reading.elapsedMs),
          );
          this.samples.add(digest(row.reading));
          this.previous = seal;
        }
      }
      this.anchorMs = this.wall();
      if (!Number.isSafeInteger(this.anchorMs) || this.anchorMs < highWater)
        throw Error("Development clock moved backward across restart");
      this.originMono = this.mono();
      this.lastMono = this.originMono;
      this.lastWall = this.anchorMs;
      this.epochs.set(this.epoch, this.anchorMs);
      this.retain("EPOCH", {
        epoch: this.epoch,
        anchorMs: this.anchorMs,
        elapsedMs: 0,
        wallMs: this.anchorMs,
      });
    } catch (error) {
      unlinkSync(this.lock);
      throw error;
    }
  }
  private retain(kind: "EPOCH" | "SAMPLE", reading: Reading) {
    const payload = { previous: this.previous, kind, reading };
    const seal = signature(this.key, "journal", payload);
    const fd = openSync(this.journal, "a", 0o600);
    try {
      appendFileSync(fd, `${JSON.stringify({ ...payload, seal })}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.previous = seal;
    this.samples.add(digest(reading));
  }
  startMonitor() {
    this.timer = setInterval(() => {
      try {
        this.retain("SAMPLE", this.check());
      } catch {
        this.poisoned = true; /* Latched; all subsequent admission refuses. */
      }
    }, 1000);
    this.timer.unref();
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    if (existsSync(this.lock) && readFileSync(this.lock, "utf8") === String(process.pid))
      unlinkSync(this.lock);
  }
  check(): Reading {
    validateEnvironment(this.environment, this.installation);
    if (this.poisoned)
      throw Error(
        "Development clock discontinuity; restart and original-operation recovery required",
      );
    const now = this.wall(),
      tick = this.mono(),
      elapsedMs = tick - this.originMono;
    if (
      !Number.isSafeInteger(now) ||
      !Number.isFinite(tick) ||
      tick < this.lastMono ||
      tick - this.lastMono > MAX_MONITOR_GAP_MS ||
      now < this.lastWall ||
      Math.abs(now - this.anchorMs - elapsedMs) > CLOCK_STEP_LIMIT_MS
    ) {
      this.poisoned = true;
      throw Error("Development clock step, suspension or uncertainty detected");
    }
    this.lastMono = tick;
    this.lastWall = now;
    return { epoch: this.epoch, anchorMs: this.anchorMs, elapsedMs, wallMs: now };
  }
  profile(epoch: string = this.epoch): QualifiedConsentHost {
    if (!this.epochs.has(epoch)) throw Error("Unknown development clock epoch");
    return {
      approvedBootId: epoch,
      authorityId: CONTRACT,
      hostId: `development:${this.installation.installationId}`,
      configurationHash: digest(this.installation),
      chronycPath: "development:no-chrony",
      chronycSocketPath: "development:no-chrony",
      chronycVersionOutput: VERSION,
      referenceIds: [REFERENCE],
      maxAcquireMs: MAX_MONITOR_GAP_MS,
      maxSampleAgeMs: MAX_MONITOR_GAP_MS,
      maxErrorMs: CLOCK_STEP_LIMIT_MS + 1,
      maxDriftPpm: 0,
      minRemainingMs: 1000,
      auditKey: Buffer.from(this.key),
    };
  }
  observe(witnessHash: string): HostObservation {
    hash.parse(witnessHash);
    const reading = this.check();
    try {
      this.retain("SAMPLE", reading);
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
    const p = this.profile(),
      projected = reading.anchorMs + reading.elapsedMs;
    const payload = {
      version: 1 as const,
      authorityId: CONTRACT,
      hostId: p.hostId,
      configurationHash: p.configurationHash,
      bootId: reading.epoch,
      witnessHash,
      earliestMs: Math.floor(Math.min(reading.wallMs, projected)),
      latestMs: Math.ceil(Math.max(reading.wallMs, projected)),
      acquiredMs: 0,
      referenceId: REFERENCE,
      referenceTimeMs: reading.anchorMs,
      tracking: JSON.stringify(reading),
      versionOutput: VERSION,
    };
    return { ...payload, seal: signature(this.key, "observation", payload) };
  }
  verify(value: HostObservation, witnessHash: string): HostObservation {
    const { seal, ...payload } = value;
    const reading = readingSchema.parse(JSON.parse(value.tracking));
    const p = this.profile(value.bootId),
      projected = reading.anchorMs + reading.elapsedMs;
    if (
      value.witnessHash !== witnessHash ||
      value.authorityId !== CONTRACT ||
      value.hostId !== p.hostId ||
      value.configurationHash !== p.configurationHash ||
      value.referenceId !== REFERENCE ||
      value.versionOutput !== VERSION ||
      reading.epoch !== value.bootId ||
      this.epochs.get(reading.epoch) !== reading.anchorMs ||
      !this.samples.has(digest(reading)) ||
      value.referenceTimeMs !== reading.anchorMs ||
      value.acquiredMs !== 0 ||
      Math.abs(reading.wallMs - projected) > CLOCK_STEP_LIMIT_MS ||
      value.earliestMs !== Math.floor(Math.min(reading.wallMs, projected)) ||
      value.latestMs !== Math.ceil(Math.max(reading.wallMs, projected)) ||
      !same(seal, signature(this.key, "observation", payload))
    )
      throw Error("Invalid development-only consent evidence");
    return value;
  }
}

let composed: DevelopmentClock | undefined;
export function compose(clock: DevelopmentClock) {
  if (composed) throw Error("Development authority already composed");
  composed = clock;
}
export function requireDevelopmentClock() {
  if (!composed) throw Error("Explicit main development purchase startup required");
  composed.check();
  return composed;
}
