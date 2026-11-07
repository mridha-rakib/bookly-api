import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Response } from "express";

/** One RFC 4180 record: every cell quoted, embedded quotes doubled, CR/LF/commas kept inside the
 * quotes. Text a spreadsheet could evaluate (`= + - @`, also after leading whitespace/control
 * characters, or a leading tab/CR/LF) is prefixed with `'`. Finite numbers are written as-is so
 * signed amounts stay numeric (a number cannot carry a formula); Dates are ISO 8601; null and
 * undefined are empty. */
export function csvRow(values: unknown[]): string {
  return `${values
    .map((value) => {
      if (typeof value === "number" && Number.isFinite(value)) return `"${value}"`;
      const raw = value instanceof Date ? value.toISOString() : String(value ?? "");
      const safe =
        /^[=+\-@]/u.test(raw.replace(/^[\s\p{Cc}]*/u, "")) || /^[\t\r\n]/u.test(raw)
          ? `'${raw}`
          : raw;
      return `"${safe.replace(/"/g, '""')}"`;
    })
    .join(",")}\r\n`;
}
/** Authorization happens in load(), including the first page before headers. Bounded page
 * memory, response backpressure and disconnection stop additional reads. Never buffers entities. */
export async function streamCsv<T>(
  response: Response,
  name: string,
  headers: string[],
  load: (page: number) => Promise<{ rows: T[]; total: number }>,
  values: (row: T) => unknown[],
) {
  const first = await load(1);
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  response.setHeader("Cache-Control", "no-store");
  async function* chunks() {
    yield `\uFEFF${csvRow(headers)}`;
    let current = first,
      page = 1,
      emitted = 0;
    while (!response.destroyed) {
      for (const row of current.rows) {
        yield csvRow(values(row));
        emitted++;
      }
      if (!current.rows.length || emitted >= first.total) break;
      current = await load(++page);
    }
  }
  await pipeline(Readable.from(chunks()), response);
}
