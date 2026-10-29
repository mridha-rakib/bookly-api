import type { Types } from "mongoose";
import { logger } from "../../config/logger.js";
import type { OrdinaryCalendarDeliveryOutcome } from "./ordinary-calendar-dispatch.js";
import {
  classifyOrdinaryCalendarIncident,
  type OrdinaryCalendarIncidentCategory,
} from "./ordinary-calendar-incident.js";
import {
  ORDINARY_CALENDAR_ISSUER_WINDOW_MS,
  OrdinaryCalendarJournalRepository,
} from "./ordinary-calendar-journal.js";
import { verifyOrdinaryCalendarDeliveryAuthority } from "./ordinary-calendar-journal-authority.js";

export type OrdinaryCalendarWorkerCounts = {
  scanned: number;
  done: number;
  retry: number;
  blocked: number;
  skipped: number;
  failed: number;
  /** Due rows not started because a stop was requested; they stay durable and due. */
  interrupted: number;
  /** Open incidents by category, from one bounded read-only scan after the pass. */
  incidents: Partial<Record<OrdinaryCalendarIncidentCategory, number>>;
};

/**
 * P4B-2B/2C — one bounded, serial pass over due journal-owned rows. Correctness lives in the
 * journal CAS (claim lease, durable issue, one-time send permission), not in this loop, so
 * several hosts may run it. It never scans SHADOW, historical or Package rows. A stop request
 * prevents new deliveries; an in-flight delivery finishes or leaves a durable uncertain state.
 * Logs carry identifiers, counts and error classes only: never tokens or provider bodies.
 */
export class OrdinaryCalendarWorker {
  constructor(
    private readonly dispatch: {
      deliver(journalId: Types.ObjectId): Promise<OrdinaryCalendarDeliveryOutcome>;
    },
    private readonly repository = new OrdinaryCalendarJournalRepository(),
    private readonly options: { batchSize: number; incidentScanLimit?: number } = { batchSize: 25 },
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async runOnce(shouldStop: () => boolean = () => false): Promise<OrdinaryCalendarWorkerCounts> {
    await verifyOrdinaryCalendarDeliveryAuthority();
    const due = await this.repository.listDue(this.options.batchSize);
    const counts: OrdinaryCalendarWorkerCounts = {
      scanned: due.length,
      done: 0,
      retry: 0,
      blocked: 0,
      skipped: 0,
      failed: 0,
      interrupted: 0,
      incidents: {},
    };
    for (const [index, row] of due.entries()) {
      if (shouldStop()) {
        counts.interrupted = due.length - index;
        logger.warn(
          {
            event: "ORDINARY_CALENDAR_WORKER_STOPPED_WITH_DUE_WORK",
            remaining: counts.interrupted,
          },
          "Ordinary Calendar worker stopped before finishing its batch; remaining rows stay due",
        );
        break;
      }
      try {
        const outcome = await this.dispatch.deliver(row._id);
        if (outcome === "DONE") counts.done += 1;
        else if (outcome === "RETRY") counts.retry += 1;
        else if (outcome === "BLOCKED") counts.blocked += 1;
        else counts.skipped += 1;
      } catch (error) {
        counts.failed += 1;
        logger.warn(
          {
            event: "ORDINARY_CALENDAR_DELIVERY_FAILED",
            journalId: String(row._id),
            errorCategory: error instanceof Error ? error.name : "UNKNOWN",
          },
          "Ordinary Calendar delivery failed; the journal keeps its durable state",
        );
      }
    }
    if (!shouldStop()) {
      const now = this.clock();
      for (const row of await this.repository.listIncidents(
        this.options.incidentScanLimit ?? 100,
        ORDINARY_CALENDAR_ISSUER_WINDOW_MS,
      )) {
        const incident = classifyOrdinaryCalendarIncident(
          row,
          now,
          ORDINARY_CALENDAR_ISSUER_WINDOW_MS,
        );
        if (incident)
          counts.incidents[incident.category] = (counts.incidents[incident.category] ?? 0) + 1;
      }
      if (Object.keys(counts.incidents).length > 0)
        logger.warn(
          { event: "ORDINARY_CALENDAR_INCIDENTS", incidents: counts.incidents },
          "Ordinary Calendar rows need attention",
        );
    }
    return counts;
  }
}

/** P4B-2C — the single consumer composition used by the launcher. Lazy: nothing is built or
 * connected until the delivery authority has already succeeded in the caller. */
export async function buildOrdinaryCalendarWorker(options: { batchSize: number }) {
  const { IntegrationService } = await import("../integration/integration.service.js");
  const { IntegrationRepository } = await import("../integration/integration.repository.js");
  const { BusinessRepository } = await import("../business/business.repository.js");
  return new OrdinaryCalendarWorker(
    new IntegrationService(
      new IntegrationRepository(),
      new BusinessRepository(),
    ).ordinaryCalendarDelivery(),
    undefined,
    options,
  );
}
