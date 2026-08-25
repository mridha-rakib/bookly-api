/**
 * Batch 16 — Book Again. Every field here is explicitly historical/informational — never reused
 * as authoritative input to a new booking (confirmed rule). `serviceId`/`staffMembershipId` exist
 * only so the frontend MAY pre-open that same service on the real venue page; if the Service is
 * since archived/inactive, the venue page's own real catalog simply won't contain it and the
 * preselection silently no-ops — no special "still valid" flag is computed here (that would be
 * re-deriving booking-engine authority a second time; the ONE real check happens where it always
 * has, at booking time). A candidate whose Business is no longer publicly visible (PENDING/
 * SUSPENDED) is excluded from this list entirely (see book-again.service.ts) so no dead-end card
 * is ever shown.
 */
export type BookAgainCandidateDto = {
  /** The ORIGINAL booking's id — informational only (e.g. "you booked this on..."), never reused
   * to create the new booking. */
  originalBookingId: string;
  originalReference: string;
  businessId: string;
  businessName: string;
  businessImageUrl?: string | undefined;
  primaryServiceName: string;
  serviceId: string;
  staffMembershipId?: string | undefined;
  originalStartAt: string;
  originalTotalCents: number;
  currency: string;
};

export type BookAgainListResult = {
  candidates: BookAgainCandidateDto[];
  pagination: { page: number; limit: number; total: number };
};
