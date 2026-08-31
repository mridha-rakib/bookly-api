import { model, Schema, type Types } from "mongoose";

import {
  STATIC_PAGE_BODY_HTML_MAX_LENGTH,
  STATIC_PAGE_TITLE_MAX_LENGTH,
  type StaticPageKey,
  staticPageKeys,
} from "./content.types.js";

/**
 * One row per system legal page. The collection holds at most 4 documents (one per
 * `staticPageKeys`). A row is created the first time a SUPER_ADMIN saves that page (upsert);
 * before that the admin/public surfaces treat the page as "not created yet".
 *
 * No `status` — these pages are always live. `bodyHtml` is stored already-sanitized.
 * `createdByUserId` / `updatedByUserId` are internal and never appear in a public DTO.
 */
export type StaticPageDocument = {
  _id: Types.ObjectId;
  pageKey: StaticPageKey;
  title: string;
  bodyHtml: string;
  createdByUserId: Types.ObjectId;
  updatedByUserId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

const staticPageSchema = new Schema<StaticPageDocument>(
  {
    pageKey: { type: String, enum: staticPageKeys, required: true },
    title: { type: String, required: true, trim: true, maxlength: STATIC_PAGE_TITLE_MAX_LENGTH },
    bodyHtml: { type: String, required: true, maxlength: STATIC_PAGE_BODY_HTML_MAX_LENGTH },
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

// `pageKey` is the stable identity and the only lookup key (admin + public). Unique — a tiny
// fixed collection, no other index is needed.
staticPageSchema.index({ pageKey: 1 }, { unique: true });

export const StaticPageModel = model<StaticPageDocument>("StaticPage", staticPageSchema);
