import type {
  PackageCalendarDeliveryPort,
  PackageCalendarObservation,
} from "../../src/modules/booking/package-calendar-delivery.js";

/**
 * P2C — in-memory fake of one calendar per Business; no network. Models the normal 409 and
 * readable-tombstone responses, not Google's full consistency contract or permanent tombstones.
 * Tests may delete entries from `events` to model tombstone expiry or a missing observation.
 */
export type FakeCalendarEvent = {
  businessId: string;
  status: string;
  summary: string;
  description: string;
  timezone: string;
  startAt: Date;
  endAt: Date;
  marker: { booklyBookingId?: string; booklyBusinessId?: string };
  etag?: string;
};

export const fakePackageCalendar = (
  opts: {
    connected?: (businessId: string) => boolean;
    loseInsertResponses?: number;
    losePatchResponses?: number;
    loseDeleteResponses?: number;
  } = {},
) => {
  /** Keyed by `${businessId}/${eventId}`: each Business has its own calendar. */
  const events = new Map<string, FakeCalendarEvent>();
  const calls: string[] = [];
  let lose = opts.loseInsertResponses ?? 0;
  let losePatch = opts.losePatchResponses ?? 0;
  let loseDelete = opts.loseDeleteResponses ?? 0;
  let version = 0;
  const connected = (businessId: string) => opts.connected?.(businessId) ?? true;
  const key = (businessId: string, eventId: string) => `${businessId}/${eventId}`;
  const port: PackageCalendarDeliveryPort = {
    read: async (businessId, eventId): Promise<PackageCalendarObservation> => {
      calls.push(`read:${eventId}`);
      if (!connected(businessId)) return { outcome: "NOT_CONNECTED" };
      const e = events.get(key(businessId, eventId));
      return e
        ? {
            outcome: "FOUND",
            status: e.status,
            startAt: e.startAt,
            endAt: e.endAt,
            marker: { ...e.marker },
            ...(e.etag ? { etag: e.etag } : {}),
          }
        : { outcome: "NOT_FOUND" };
    },
    insert: async (businessId, eventId, event, marker) => {
      calls.push(`insert:${eventId}`);
      if (!connected(businessId)) return "NOT_CONNECTED";
      if (events.has(key(businessId, eventId))) return "ALREADY_EXISTS";
      events.set(key(businessId, eventId), {
        businessId,
        status: "confirmed",
        summary: event.summary,
        description: event.description,
        timezone: event.timezone,
        startAt: event.startAt,
        endAt: event.endAt,
        marker,
        etag: `"${++version}"`,
      });
      // A lost provider response AFTER the write was applied (ambiguous success).
      if (lose-- > 0) throw new Error("controlled lost insert response");
      return "CREATED";
    },
    patchSchedule: async (businessId, eventId, schedule, ifMatch) => {
      calls.push(`patch:${eventId}`);
      if (!connected(businessId)) return "NOT_CONNECTED";
      const e = events.get(key(businessId, eventId));
      if (!e || e.status === "cancelled") return "NOT_FOUND";
      if (ifMatch && ifMatch !== e.etag) return "PRECONDITION_FAILED";
      e.startAt = schedule.startAt;
      e.endAt = schedule.endAt;
      e.timezone = schedule.timezone;
      e.etag = `"${++version}"`;
      if (losePatch-- > 0) throw new Error("controlled lost patch response");
      return "UPDATED";
    },
    remove: async (businessId, eventId, ifMatch) => {
      calls.push(`remove:${eventId}`);
      if (!connected(businessId)) return "NOT_CONNECTED";
      const e = events.get(key(businessId, eventId));
      if (e && ifMatch && ifMatch !== e.etag) return "PRECONDITION_FAILED";
      if (e) {
        e.status = "cancelled";
        e.etag = `"${++version}"`;
      }
      if (loseDelete-- > 0) throw new Error("controlled lost delete response");
      return "DELETED";
    },
  };
  const live = () => [...events.values()].filter((e) => e.status !== "cancelled");
  const writes = () => calls.filter((c) => /^(insert|patch|remove):/.test(c));
  const seed = (
    businessId: string,
    eventId: string,
    event: Omit<FakeCalendarEvent, "businessId">,
  ) => events.set(key(businessId, eventId), { businessId, etag: `"${++version}"`, ...event });
  const get = (businessId: string, eventId: string) => events.get(key(businessId, eventId));
  return { port, events, calls, live, writes, seed, get };
};
