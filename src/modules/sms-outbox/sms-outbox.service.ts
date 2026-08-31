import { type EnqueueSmsResult, SmsOutboxRepository } from "./sms-outbox.repository.js";
import type { EnqueueSmsInput } from "./sms-outbox.types.js";

/**
 * The seam Stage 3B's reminder dispatch will call after it has resolved a verified E.164 number
 * and rendered the final body:
 *
 *   await smsOutboxService.enqueue({ eventKey, recipientE164, body });
 *
 * Idempotent by construction — a retried request with the same deterministic `eventKey` +
 * recipient resolves to the already-queued row instead of creating a second one.
 */
export class SmsOutboxService {
  public constructor(
    private readonly repository: SmsOutboxRepository = new SmsOutboxRepository(),
  ) {}

  public enqueue(input: EnqueueSmsInput): Promise<EnqueueSmsResult> {
    return this.repository.enqueue(input);
  }
}
