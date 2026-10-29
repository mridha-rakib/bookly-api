import { createHash } from "node:crypto";
import { z } from "zod";
import type { BookingDocument } from "./booking.model.js";
import {
  CANCELLED_BOOKING_STATUSES,
  packageCalendarEventFor,
} from "./package-calendar-delivery.js";

const id = z.string().regex(/^[a-f0-9]{24}$/);
export const calendarTaskReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("BATCH"), claimId: id, key: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("LIFECYCLE"),
      operationId: id,
      index: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type CalendarTaskReference = z.infer<typeof calendarTaskReferenceSchema>;
export const calendarTaskIdentity = (task: CalendarTaskReference) =>
  task.kind === "BATCH"
    ? `BATCH:${task.claimId}:${task.key}`
    : `LIFECYCLE:${task.operationId}:${task.index}`;

export const calendarDestinationSchema = z
  .object({
    businessId: id,
    integrationId: id,
    generation: z.uuid(),
    accountId: z.string().min(1),
    accountEmail: z.string().min(1),
    configuredCalendarId: z.string().min(1),
    calendarId: z
      .string()
      .min(1)
      .refine((value) => value !== "primary"),
  })
  .strict();
export type CalendarDestination = z.infer<typeof calendarDestinationSchema>;
const event = z
  .object({
    summary: z.string(),
    description: z.string(),
    startAt: z.date(),
    endAt: z.date(),
    timezone: z.string().min(1),
  })
  .strict();
const desired = z.discriminatedUnion("kind", [
  event.extend({ kind: z.literal("PRESENT") }),
  z.object({ kind: z.literal("ABSENT") }).strict(),
  z.object({ kind: z.literal("UNCHANGED") }).strict(),
]);
export const calendarJournalSchema = z
  .object({
    version: z.literal(1),
    businessId: id,
    bookingId: id,
    customerUserId: id,
    businessClientId: id,
    packageProgressId: id,
    purchaseClaimId: id,
    destination: calendarDestinationSchema,
    eventId: z.string().min(5),
    latest: z
      .object({
        task: calendarTaskReferenceSchema,
        taskId: z.string(),
        revision: z.string().length(64),
        desired,
        decisionId: z.uuid(),
        actorUserId: id,
        releasedAt: z.date(),
        sessionFamilyId: z.string().min(1),
      })
      .strict(),
    state: z.enum([
      "NOT_DISPATCHED",
      "DISPATCH_PREPARED",
      "REQUEST_ISSUED",
      "CONFIRMED_DELIVERED",
      "UNKNOWN_OUTCOME",
      "RETRYABLE_FAILURE",
      "PERMANENT_FAILURE",
      "BLOCKED_AUTHORITY",
    ]),
    createIssued: z.boolean(),
    lease: z.object({ token: z.uuid(), expiresAt: z.date() }).strict().optional(),
    request: z
      .object({
        id: z.uuid(),
        kind: z.enum(["INSERT", "PATCH", "DELETE"]),
        revision: z.string(),
        issuedAt: z.date(),
        settled: z.boolean(),
        etag: z.string().optional(),
        providerStarted: z.boolean().optional(),
      })
      .strict()
      .optional(),
    confirmedRevision: z.string().optional(),
    reason: z.string().optional(),
    decisions: z.array(
      z
        .object({
          decisionId: z.uuid(),
          actorUserId: id,
          taskId: z.string(),
          revision: z.string(),
          reason: z.string().min(1).max(1000),
          at: z.date(),
          sessionFamilyId: z.string().min(1),
        })
        .strict(),
    ),
    recovery: z
      .object({
        requestId: z.uuid().optional(),
        actorUserId: id,
        incidentReference: z.string().min(1),
        at: z.date(),
        assertion: z.literal("ALL_ISSUERS_QUIESCED_AND_PROVIDER_SETTLED"),
        sessionFamilyId: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CalendarJournal = z.infer<typeof calendarJournalSchema>;

export function calendarBookingIntent(booking: BookingDocument) {
  const mapped = packageCalendarEventFor(booking);
  const desiredState: z.infer<typeof desired> =
    booking.status === "UPCOMING"
      ? { kind: "PRESENT", ...mapped }
      : CANCELLED_BOOKING_STATUSES.has(booking.status) || booking.status === "NO_SHOW_CANCELLED"
        ? { kind: "ABSENT" }
        : { kind: "UNCHANGED" };
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        status: booking.status,
        eventVersion: booking.eventHistory.length,
        lifecycleVersion: booking.rescheduleHistory.length,
        ...mapped,
      }),
    )
    .digest("hex");
  return { revision, desired: desiredState };
}

// Journal writes use exact-record CAS and are never accepted through generic Booking writers.
const journalWrites = new WeakSet<object>();
export const grantCalendarJournalWrite = <T extends object>(query: T): T => {
  journalWrites.add(query);
  return query;
};
export const isCalendarJournalWrite = (query: object) => journalWrites.has(query);
