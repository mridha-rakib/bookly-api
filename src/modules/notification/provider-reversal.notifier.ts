import { logger } from "../../config/logger.js";
import type { BusinessDocument } from "../business/business.model.js";
import { INTERNAL_NOTIFICATION_RECIPIENTS } from "../email/email.config.js";
import { formatMoney } from "../email/templates/components/email-format.js";
import type {
  FinanceSupportAlertEmailData,
  FinanceSupportAlertKind,
  ProviderReversalBusinessEmailData,
  ProviderReversalBusinessKind,
} from "../email/templates/finance/provider-reversal.template.js";
import type { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import type { BookingNotificationUserPort } from "./booking-created.notifier.js";
import { normalizeRecipient } from "./notification-recipients.js";

type OutboxEnqueue = Pick<EmailOutboxService, "enqueue">;

export type SupportAlertInput = {
  kind: FinanceSupportAlertKind;
  /** Stable dedupe identity (e.g. the provider dispute/refund/event id). */
  identity: string;
  providerReference: string;
  amountCents?: number | undefined;
  currency?: string | undefined;
  businessId?: string | undefined;
  bookingId?: string | undefined;
  detail?: string | undefined;
};

export type BusinessReversalAlertInput = {
  kind: ProviderReversalBusinessKind;
  identity: string;
  providerReference: string;
  amountCents: number;
  currency: string;
  bookingReference: string;
};

export type ProviderReversalNotificationPort = {
  notifySupport(alert: SupportAlertInput): Promise<void>;
  notifyBusiness(business: BusinessDocument, alert: BusinessReversalAlertInput): Promise<void>;
};

/**
 * P6 — dispute / external-refund notifications on the existing outbox. Support (the internal
 * admin + support mailboxes, like BUSINESS_REGISTERED) always; the affected Business Owner only for
 * meaningful transitions of money it owns. One notification per (kind, identity) — the outbox
 * eventKey dedupes repeated provider updates and webhook/polling races. Never a customer. Never
 * throws (a notification problem never blocks accounting).
 */
export class ProviderReversalNotifier implements ProviderReversalNotificationPort {
  public constructor(
    private readonly emailOutbox: OutboxEnqueue,
    private readonly users: Pick<BookingNotificationUserPort, "findManyByIds">,
  ) {}

  public async notifySupport(alert: SupportAlertInput): Promise<void> {
    try {
      const payload: FinanceSupportAlertEmailData = {
        kind: alert.kind,
        providerReference: alert.providerReference,
        ...(alert.amountCents !== undefined && alert.currency
          ? { amountFormatted: formatMoney(alert.amountCents, alert.currency) }
          : {}),
        ...(alert.businessId ? { businessId: alert.businessId } : {}),
        ...(alert.bookingId ? { bookingId: alert.bookingId } : {}),
        ...(alert.detail ? { detail: alert.detail.slice(0, 500) } : {}),
      };
      const recipients = [...new Set(INTERNAL_NOTIFICATION_RECIPIENTS.map(normalizeRecipient))];
      for (const recipient of recipients) {
        await this.emailOutbox.enqueue({
          eventKey: `FINANCE_ALERT:${alert.kind}:${alert.identity}`,
          templateKey: "FINANCE_SUPPORT_ALERT",
          recipient,
          payload: payload as unknown as Record<string, unknown>,
        });
      }
    } catch (error) {
      logger.error(
        { err: error, kind: alert.kind, identity: alert.identity },
        "Failed to enqueue finance support alert",
      );
    }
  }

  public async notifyBusiness(
    business: BusinessDocument,
    alert: BusinessReversalAlertInput,
  ): Promise<void> {
    try {
      const [owner] = await this.users.findManyByIds([String(business.ownerUserId)]);
      const recipient = owner ? normalizeRecipient(owner.normalizedEmail) : undefined;
      if (!recipient) return;
      const payload: ProviderReversalBusinessEmailData = {
        kind: alert.kind,
        businessName: business.name,
        amountFormatted: formatMoney(alert.amountCents, alert.currency),
        bookingReference: alert.bookingReference,
        providerReference: alert.providerReference,
      };
      await this.emailOutbox.enqueue({
        eventKey: `PROVIDER_REVERSAL:${alert.kind}:${alert.identity}`,
        templateKey: "PROVIDER_REVERSAL_BUSINESS",
        recipient,
        payload: payload as unknown as Record<string, unknown>,
      });
    } catch (error) {
      logger.error(
        { err: error, kind: alert.kind, identity: alert.identity },
        "Failed to enqueue provider reversal business notification",
      );
    }
  }
}
