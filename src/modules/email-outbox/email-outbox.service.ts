import { EmailOutboxRepository, type EnqueueEmailResult } from "./email-outbox.repository.js";
import type { EnqueueEmailInput } from "./email-outbox.types.js";

/**
 * The seam Stage B/C/D domain services call after a domain operation commits:
 *
 *   await emailOutboxService.enqueue({ eventKey, templateKey, recipient, payload });
 *
 * Idempotent by construction — a retried request with the same deterministic `eventKey` +
 * template + recipient resolves to the already-queued row instead of creating a second one.
 */
export class EmailOutboxService {
  public constructor(
    private readonly repository: EmailOutboxRepository = new EmailOutboxRepository(),
  ) {}

  public enqueue(input: EnqueueEmailInput): Promise<EnqueueEmailResult> {
    return this.repository.enqueue(input);
  }
}
