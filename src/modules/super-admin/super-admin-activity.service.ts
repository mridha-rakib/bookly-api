import type { BusinessRepository } from "../business/business.repository.js";
import type { BusinessPayoutRepository } from "../finance/business-payout.repository.js";
import type { UserRepository } from "../user/user.repository.js";

export type SuperAdminActivityEventType =
  | "BUSINESS_APPLICATION"
  | "BUSINESS_STATUS_CHANGED"
  | "CUSTOMER_REGISTERED"
  | "PAYOUT_PAID";

export type SuperAdminActivityEvent = {
  type: SuperAdminActivityEventType;
  occurredAt: string;
  summary: string;
};

const PER_SOURCE_LIMIT = 15;

/** Batch 12 — Recent Activity, deferred in Batch 11 pending a real derivation. Deliberately NOT
 * a new audit/event system: bounded, merge-sorted from four ALREADY-authoritative sources
 * (Business creation, Business statusHistory — Batch 11's own audit trail, Customer registration,
 * BusinessPayout) — never a booking-level event (eventHistory's `type` values don't map to
 * anything an admin-facing feed could summarize honestly without guessing at intent). */
export class SuperAdminActivityService {
  public constructor(
    private readonly businessRepository: BusinessRepository,
    private readonly userRepository: UserRepository,
    private readonly businessPayoutRepository: BusinessPayoutRepository,
  ) {}

  public async getRecentActivity(
    limit: number,
  ): Promise<{ activities: SuperAdminActivityEvent[] }> {
    const [newBusinesses, changedBusinesses, newCustomers, payouts] = await Promise.all([
      this.businessRepository.findRecentlyCreated(PER_SOURCE_LIMIT),
      this.businessRepository.findRecentlyChanged(PER_SOURCE_LIMIT),
      this.userRepository.findRecentlyCreated("CUSTOMER", PER_SOURCE_LIMIT),
      this.businessPayoutRepository.listAll({ page: 1, limit: PER_SOURCE_LIMIT }),
    ]);

    const events: SuperAdminActivityEvent[] = [];

    for (const business of newBusinesses) {
      events.push({
        type: "BUSINESS_APPLICATION",
        occurredAt: business.createdAt.toISOString(),
        summary: `New business application received — ${business.name}`,
      });
    }

    for (const business of changedBusinesses) {
      const latest = [...business.statusHistory].sort(
        (a, b) => b.changedAt.getTime() - a.changedAt.getTime(),
      )[0];
      if (!latest) continue;
      events.push({
        type: "BUSINESS_STATUS_CHANGED",
        occurredAt: latest.changedAt.toISOString(),
        summary: `${business.name} — ${latest.fromStatus} → ${latest.toStatus}`,
      });
    }

    for (const user of newCustomers) {
      events.push({
        type: "CUSTOMER_REGISTERED",
        occurredAt: user.createdAt.toISOString(),
        summary: `New customer registered — ${user.normalizedEmail}`,
      });
    }

    for (const payout of payouts.items) {
      if (!payout.paidAt) continue;
      events.push({
        type: "PAYOUT_PAID",
        occurredAt: payout.paidAt.toISOString(),
        summary: `Payout sent — €${(payout.netPayoutCents / 100).toFixed(2)}`,
      });
    }

    events.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
    return { activities: events.slice(0, limit) };
  }
}
