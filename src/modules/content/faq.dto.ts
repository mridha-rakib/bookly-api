import type { FaqAudience, FaqStatus } from "./content.types.js";
import type { FaqDocument } from "./faq.model.js";

/** Full admin-facing shape — Content Manager needs `status`/`order` to render and reorder. */
export type FaqDto = {
  id: string;
  question: string;
  answer: string;
  audience: FaqAudience;
  status: FaqStatus;
  order: number;
  createdAt: string;
  updatedAt: string;
};

export const toFaqDto = (doc: FaqDocument): FaqDto => ({
  id: String(doc._id),
  question: doc.question,
  answer: doc.answer,
  audience: doc.audience,
  status: doc.status,
  order: doc.order,
  createdAt: doc.createdAt.toISOString(),
  updatedAt: doc.updatedAt.toISOString(),
});

/** Public shape — question + answer only. No status, no order, no audience, no author, no
 * timestamps: nothing a public visitor has any use for, and nothing that could leak a draft's
 * existence. Only ever built from an already PUBLISHED-filtered, order-sorted list. */
export type PublicFaqDto = {
  id: string;
  question: string;
  answer: string;
};

export const toPublicFaqDto = (doc: FaqDocument): PublicFaqDto => ({
  id: String(doc._id),
  question: doc.question,
  answer: doc.answer,
});
