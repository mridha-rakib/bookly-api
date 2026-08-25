import { randomInt } from "node:crypto";

/**
 * Human-readable Support Ticket reference generator — mirrors booking.utils.ts's
 * `generateBookingReference` exactly (same alphabet excluding ambiguous 0/O/1/I characters, same
 * cryptographically random `randomInt`, same 8-character suffix). Collision handling is not built
 * into the generator itself — support-ticket.repository.ts's `create` treats a genuine collision
 * (a Mongo E11000 on the unique `reference` index) as still-possible and retries, matching the
 * same convention.
 */
const REFERENCE_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const REFERENCE_SUFFIX_LENGTH = 8;

const pick = (charset: string): string => charset[randomInt(0, charset.length)] as string;

export const generateSupportTicketReference = (): string => {
  const suffix = Array.from({ length: REFERENCE_SUFFIX_LENGTH }, () => pick(REFERENCE_CHARS)).join(
    "",
  );
  return `TCK-${suffix}`;
};
