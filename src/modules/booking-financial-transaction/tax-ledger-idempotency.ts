/** Dark C1 primitives for future append-only tax postings. */
export const taxLiabilityIdempotencyKey = (paymentIntentId: string): string =>
  `tax-liability:${paymentIntentId}`;

export const taxReversalIdempotencyKey = (refundId: string): string => `tax-reversal:${refundId}`;
