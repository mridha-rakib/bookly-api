import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * P2B — structural guard for the invariant "a first-class member Booking is never committed
 * without the purchase's commercial completion".
 *
 * Source facts this pins (package-batch-financial-persistence.ts `complete`):
 *  - payment must already be `succeeded` before any persistence is claimed;
 *  - materializeInSession (member Bookings, occupancy, Progress), the finance/ledger/attempt
 *    writes, delivery intents and appendBatchCompletion (PREPARATION_COMPLETE) all run inside
 *    ONE session.withTransaction callback, so they commit or abort together.
 * The standalone PackageBatchPersistence.materialize() commits internal materialization alone;
 * it is engineering/test-only and must never be reachable from production source.
 * Behavioural coverage of the same invariant: package-batch-financial-database.integration
 * (F2-25/52/53/54, F2-51/55, F2-56, F2-59, F2-19/20).
 */

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
}));

const PERSISTENCE = "modules/booking/package-batch-persistence.ts";
const F2_PARENT = "modules/booking/package-batch-financial-persistence.ts";
const GATED_FACTORY = "modules/booking/package-purchase-http.ts";

describe("first-class member Bookings commit only with commercial completion", () => {
  it("only the gated purchase composition constructs the internal batch writer", () => {
    const offenders = files
      .filter((f) => f.path !== PERSISTENCE && f.text.includes("new PackageBatchPersistence("))
      .map((f) => f.path);
    expect(offenders).toEqual([GATED_FACTORY]);
  });

  it("production modules import the internal batch writer only as a type", () => {
    const valueImports = files.filter((f) =>
      f.text
        .split("\n")
        .some(
          (line) =>
            /from ["'][./]+.*package-batch-persistence\.js["']/.test(line) &&
            !/^\s*import\s+type\s/.test(line),
        ),
    );
    expect(valueImports.map((f) => f.path)).toEqual([GATED_FACTORY]);
  });

  it("materializeInSession is called only by the F2 parent", () => {
    const callers = files.filter((f) => /\.materializeInSession\(/.test(f.text)).map((f) => f.path);
    expect(callers).toEqual([F2_PARENT]);
  });

  it("the F2 parent materializes and appends completion inside its single transaction", () => {
    const parent = files.find((f) => f.path === F2_PARENT)?.text ?? "";
    expect(parent.match(/\.withTransaction\(/g)).toHaveLength(1);
    const open = parent.indexOf(".withTransaction(");
    const materialize = parent.indexOf(".materializeInSession(");
    const append = parent.indexOf("appendBatchCompletion(");
    const committed = parent.indexOf("returned = true;");
    expect(open).toBeGreaterThan(-1);
    expect(open).toBeLessThan(materialize);
    expect(materialize).toBeLessThan(append);
    expect(append).toBeLessThan(committed);
    // Persistence is claimed only after the provider reported success.
    const succeeded = parent.indexOf('charge.status !== "succeeded"');
    const claimed = parent.indexOf("claimInternalPackageBatch(scope, p)");
    expect(succeeded).toBeGreaterThan(-1);
    expect(succeeded).toBeLessThan(claimed);
    expect(claimed).toBeLessThan(open);
  });

  it("the preparation step before payment writes no Booking, reservation or Progress", () => {
    const claimModel =
      files.find((f) => f.path === "modules/booking/booking-creation-claim.model.ts")?.text ?? "";
    const start = claimModel.indexOf("export async function prepareInternalPackageBatch");
    const end = claimModel.indexOf("export async function claimInternalPackageBatch");
    const body = claimModel.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    for (const forbidden of [
      "BookingModel",
      "BookingSlotReservation",
      "PackageProgressV2",
      "reserveOrJoin",
    ])
      expect(body).not.toContain(forbidden);
  });
});
