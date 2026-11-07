import { DateTime } from "luxon";
import { z } from "zod";
import { addCalendarDays, businessLocalToUtc } from "../../common/time/business-clock.js";

export type SlotBlock = { staffMembershipId?: string | undefined; startAt: Date; endAt: Date };
export type AvailabilityRules = {
  minimumNoticeMinutes?: number | null | undefined;
  maximumAdvanceMonths?: number | null | undefined;
  closedPeriods?: { startDate: string; endDate: string; note?: string | undefined }[] | undefined;
  slotBlocks?: SlotBlock[] | undefined;
};
const date = z.string().date();
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const closedPeriodSchema = z
  .object({ startDate: date, endDate: date, note: z.string().trim().max(500).optional() })
  .strict()
  .refine((value) => value.startDate <= value.endDate, "End date must not precede start date");
export const availabilityRulesBodySchema = z
  .object({
    minimumNoticeMinutes: z
      .union([z.literal(15), z.literal(30), z.literal(60), z.literal(120), z.literal(1440)])
      .nullable(),
    maximumAdvanceMonths: z
      .union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)])
      .nullable(),
    closedPeriods: z.array(closedPeriodSchema).max(200),
  })
  .strict();
export const localBlockSchema = z
  .object({
    staffMembershipId: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .optional(),
    startDate: date,
    startTime: time,
    endDate: date,
    endTime: time,
  })
  .strict()
  .refine(
    (value) => `${value.startDate}T${value.startTime}` < `${value.endDate}T${value.endTime}`,
    "End must be after start",
  );
export const changeBlocksBodySchema = z
  .object({
    action: z.enum(["BLOCK", "UNBLOCK"]),
    intervals: z.array(localBlockSchema).min(1).max(200),
  })
  .strict();
export type AvailabilityRulesBody = z.infer<typeof availabilityRulesBodySchema>;
export type ChangeBlocksBody = z.infer<typeof changeBlocksBodySchema>;

export function resolveLocalBlock(
  input: z.infer<typeof localBlockSchema>,
  timezone: string,
): SlotBlock {
  const startAt = businessLocalToUtc(timezone, input.startDate, input.startTime);
  const endAt = businessLocalToUtc(timezone, input.endDate, input.endTime);
  if (endAt <= startAt) throw new Error("Time range does not exist in the Business timezone");
  return { staffMembershipId: input.staffMembershipId, startAt, endAt };
}
export const overlaps = (a: { startAt: Date; endAt: Date }, b: { startAt: Date; endAt: Date }) =>
  a.startAt < b.endAt && b.startAt < a.endAt;

/** Union duplicate/overlapping blocks within each scope. Unblock subtracts only the specified
 * scope and interval, preserving adjacent ranges and unrelated Business-wide restrictions. */
export function changeSlotBlocks(
  existing: SlotBlock[],
  requested: SlotBlock[],
  action: "BLOCK" | "UNBLOCK",
): SlotBlock[] {
  // Hydrated Mongoose subdocuments expose schema fields through accessors; object spread
  // would copy internal document state and drop the persisted time boundaries.
  let result: SlotBlock[] = existing.map((block) => ({
    staffMembershipId: block.staffMembershipId,
    startAt: new Date(block.startAt),
    endAt: new Date(block.endAt),
  }));
  if (action === "BLOCK") result.push(...requested);
  else
    for (const range of requested)
      result = result.flatMap((block) => {
        if (
          String(block.staffMembershipId ?? "") !== String(range.staffMembershipId ?? "") ||
          !overlaps(block, range)
        )
          return [block];
        const fragments: SlotBlock[] = [];
        if (block.startAt < range.startAt) fragments.push({ ...block, endAt: range.startAt });
        if (block.endAt > range.endAt) fragments.push({ ...block, startAt: range.endAt });
        return fragments;
      });
  result.sort(
    (a, b) =>
      String(a.staffMembershipId ?? "").localeCompare(String(b.staffMembershipId ?? "")) ||
      +a.startAt - +b.startAt,
  );
  const merged: SlotBlock[] = [];
  for (const block of result) {
    const last = merged.at(-1);
    if (
      last &&
      String(last.staffMembershipId ?? "") === String(block.staffMembershipId ?? "") &&
      block.startAt <= last.endAt
    )
      last.endAt = new Date(Math.max(+last.endAt, +block.endAt));
    else merged.push({ ...block });
  }
  return merged;
}

/** Half-open occupied intervals include buffer/processing time. Notice uses server instants;
 * advance months use calendar arithmetic in the Business timezone, clamped at month ends. */
export function permitsAppointment(
  rules: AvailabilityRules | undefined,
  timezone: string,
  staffId: string,
  startAt: Date,
  endAt: Date,
  now: Date,
): boolean {
  if (!rules) return true;
  if (rules.minimumNoticeMinutes != null && +startAt < +now + rules.minimumNoticeMinutes * 60000)
    return false;
  if (
    rules.maximumAdvanceMonths != null &&
    +startAt >
      DateTime.fromJSDate(now, { zone: timezone })
        .plus({ months: rules.maximumAdvanceMonths })
        .toMillis()
  )
    return false;
  for (const period of rules.closedPeriods ?? []) {
    const closure = {
      startAt: businessLocalToUtc(timezone, period.startDate, "00:00"),
      endAt: businessLocalToUtc(timezone, addCalendarDays(period.endDate, 1), "00:00"),
    };
    if (overlaps(closure, { startAt, endAt })) return false;
  }
  return !(rules.slotBlocks ?? []).some(
    (block) =>
      (!block.staffMembershipId || String(block.staffMembershipId) === staffId) &&
      overlaps(block, { startAt, endAt }),
  );
}
