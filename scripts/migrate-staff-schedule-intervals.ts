#!/usr/bin/env tsx
/**
 * One-off backfill: migrates every StaffSchedule document's `days[]` entries from the old
 * single-shift shape `{ dayOfWeek, startTime, endTime }` to the new multi-interval shape
 * `{ dayOfWeek, intervals: [{ startTime, endTime }] }` (Staff Multiple Working Intervals /
 * Split Shifts feature).
 *
 * SAFETY:
 *   - Idempotent: a day already in the new shape (has an `intervals` array, no top-level
 *     `startTime`/`endTime`) is left untouched. Safe to re-run.
 *   - Never touches `offDays`, `membershipId`, or `businessId` — only rewrites `days[]`.
 *   - Reports counts only; never logs raw schedule contents (no times/days printed), per the
 *     "don't print raw schedule data unnecessarily" instruction.
 *   - Refuses to run against anything that looks like a real MongoDB Atlas cluster
 *     (`mongodb+srv://` or a `*.mongodb.net` host) unless `--force-production` is explicitly
 *     passed — and even then this script was never run against one; see the final report.
 *   - `--dry-run` (default) only reports what WOULD change; pass `--apply` to actually write.
 *
 * Usage:
 *   tsx scripts/migrate-staff-schedule-intervals.ts --dry-run   (default; same as no flag)
 *   tsx scripts/migrate-staff-schedule-intervals.ts --apply
 */
import mongoose from "mongoose";

// --- Pure transform — exported and unit-tested independently of any DB connection ----------

type LegacyDay = {
  dayOfWeek: string;
  startTime?: string;
  endTime?: string;
  intervals?: Array<{ startTime: string; endTime: string }>;
};

export type MigratedDay = {
  dayOfWeek: string;
  intervals: Array<{ startTime: string; endTime: string }>;
};

/** True if a day entry is already in the new shape (has `intervals`, no legacy
 * `startTime`/`endTime` at the top level) — the idempotency check. */
export const isAlreadyMigratedDay = (day: LegacyDay): boolean =>
  Array.isArray(day.intervals) && day.startTime === undefined && day.endTime === undefined;

/**
 * Transforms one `days[]` array. Lossless: every legacy `{startTime,endTime}` becomes exactly
 * one interval, in the same order, for the same weekday — no merging, sorting, or validation
 * here (that's the live PUT-time normalization's job; a migration must preserve exactly what
 * was already saved, since it was already valid under the old single-shift rule). Already-
 * migrated days pass through unchanged (idempotent).
 */
export const migrateScheduleDays = (days: LegacyDay[]): MigratedDay[] =>
  days.map((day) => {
    if (isAlreadyMigratedDay(day)) {
      return { dayOfWeek: day.dayOfWeek, intervals: day.intervals ?? [] };
    }

    if (day.startTime === undefined || day.endTime === undefined) {
      throw new Error(
        `Schedule day for ${day.dayOfWeek} has neither a legacy startTime/endTime pair nor an intervals array — unrecognized shape`,
      );
    }

    return {
      dayOfWeek: day.dayOfWeek,
      intervals: [{ startTime: day.startTime, endTime: day.endTime }],
    };
  });

// --- CLI entrypoint --------------------------------------------------------------------------

const isMainModule = () => {
  const entry = process.argv[1]
    ? new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href
    : "";
  return import.meta.url === entry;
};

const looksLikeProductionUri = (uri: string): boolean =>
  uri.startsWith("mongodb+srv://") || /\.mongodb\.net/i.test(uri);

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const forceProduction = args.includes("--force-production");

  const uri = process.env["MONGODB_URI"];
  if (!uri) {
    throw new Error("MONGODB_URI is not set — refusing to run without an explicit target database");
  }

  if (looksLikeProductionUri(uri) && !forceProduction) {
    throw new Error(
      "MONGODB_URI looks like a real MongoDB Atlas cluster (mongodb+srv:// or *.mongodb.net). " +
        "Refusing to run this migration against it. If this is genuinely a disposable/test " +
        "Atlas cluster, re-run with --force-production to override this guard.",
    );
  }

  await mongoose.connect(uri);

  try {
    // Minimal collection-level access — deliberately does NOT import the live Mongoose model
    // (whose schema now only accepts the NEW shape), so this can read pre-migration documents
    // exactly as stored.
    const collection = mongoose.connection.collection("staffschedules");

    const cursor = collection.find({});
    let scanned = 0;
    let migrated = 0;
    let alreadyMigrated = 0;
    let skippedEmpty = 0;

    for await (const doc of cursor) {
      scanned += 1;
      const days: LegacyDay[] = Array.isArray(doc["days"]) ? doc["days"] : [];

      if (days.length === 0) {
        skippedEmpty += 1;
        continue;
      }

      if (days.every((day) => isAlreadyMigratedDay(day))) {
        alreadyMigrated += 1;
        continue;
      }

      const migratedDays = migrateScheduleDays(days);

      if (apply) {
        await collection.updateOne(
          { _id: doc["_id"] },
          // Only ever rewrites `days` — offDays/membershipId/businessId/timestamps untouched.
          { $set: { days: migratedDays } },
        );
      }

      migrated += 1;
    }

    process.stdout.write(
      `${apply ? "APPLIED" : "DRY RUN"} — scanned ${scanned} StaffSchedule document(s): ` +
        `${migrated} migrated, ${alreadyMigrated} already in the new shape, ${skippedEmpty} had no days.\n`,
    );

    if (!apply && migrated > 0) {
      process.stdout.write("Re-run with --apply to write these changes.\n");
    }
  } finally {
    await mongoose.disconnect();
  }
};

if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
