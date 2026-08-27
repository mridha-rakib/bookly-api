import { model, Schema, type Types } from "mongoose";

import {
  FAQ_ANSWER_MAX_LENGTH,
  FAQ_QUESTION_MAX_LENGTH,
  type FaqAudience,
  type FaqStatus,
  faqAudiences,
  faqStatuses,
} from "./content.types.js";

/**
 * A single FAQ collection for the Content Manager. `audience` ("CUSTOMER" | "BUSINESS") is the
 * only thing that separates the two Content Manager tabs — there is no second collection.
 *
 * `order` is a real persisted integer, scoped per `audience` (Customer ordering never affects
 * Business ordering). New rows are appended (max existing order + 1); an explicit reorder writes
 * a fresh contiguous 0..n-1 sequence in one transaction (see faq.repository.ts `reorder`).
 */
export type FaqDocument = {
  _id: Types.ObjectId;
  question: string;
  answer: string;
  audience: FaqAudience;
  status: FaqStatus;
  order: number;
  createdByUserId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

const faqSchema = new Schema<FaqDocument>(
  {
    question: { type: String, required: true, trim: true, maxlength: FAQ_QUESTION_MAX_LENGTH },
    answer: { type: String, required: true, trim: true, maxlength: FAQ_ANSWER_MAX_LENGTH },
    audience: { type: String, enum: faqAudiences, required: true },
    status: { type: String, enum: faqStatuses, required: true, default: "PUBLISHED" },
    order: { type: Number, required: true, min: 0, validate: Number.isInteger },
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

// Admin list ("all statuses for one audience, ordered") — the Content Manager FAQ tab read.
faqSchema.index({ audience: 1, order: 1 });
// Public read ("PUBLISHED rows for one audience, ordered") — GET /content/faqs.
faqSchema.index({ audience: 1, status: 1, order: 1 });

export const FaqModel = model<FaqDocument>("Faq", faqSchema);
