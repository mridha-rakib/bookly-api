/**
 * Recipient-address hygiene shared by every notifier (Phase L). The Stage-A EmailOutbox unique
 * `dedupeKey` is the final guarantee against duplicate sends; this is the cheap in-memory pass
 * that also prevents two enqueue calls for the same semantic notification.
 */
export const normalizeRecipient = (email: string): string => email.trim().toLowerCase();

/** De-duplicates a list of `{ email, ... }` recipients by normalized address, keeping the first
 * occurrence. Entries with a blank/whitespace email are dropped. */
export const dedupeRecipients = <T extends { email: string }>(recipients: T[]): T[] => {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const recipient of recipients) {
    const normalized = normalizeRecipient(recipient.email);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push({ ...recipient, email: normalized });
  }
  return out;
};
