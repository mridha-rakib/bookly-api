import { model, Schema, type Types } from "mongoose";

import {
  type GoogleCalendarIntegrationStatus,
  googleCalendarIntegrationStatuses,
} from "./integration.types.js";

/**
 * One Google Calendar connection per Business (business-wide, Owner-connected — see product
 * scope decision recorded in this batch's audit: one-way Bookly -> Google sync, Owner-only,
 * not per-staff). Tokens are stored AES-256-GCM encrypted at rest (see integration.crypto.ts);
 * this model never exposes them beyond the integration module's own repository/service layer.
 */
export type GoogleCalendarIntegrationDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  googleAccountEmail: string;
  calendarId: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  tokenExpiresAt: Date;
  status: GoogleCalendarIntegrationStatus;
  lastSyncError?: string | undefined;
  connectedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const googleCalendarIntegrationSchema = new Schema<GoogleCalendarIntegrationDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    googleAccountEmail: { type: String, required: true, trim: true },
    calendarId: { type: String, required: true, trim: true, default: "primary" },
    encryptedAccessToken: { type: String, required: true },
    encryptedRefreshToken: { type: String, required: true },
    tokenExpiresAt: { type: Date, required: true },
    status: {
      type: String,
      enum: googleCalendarIntegrationStatuses,
      required: true,
      default: "CONNECTED",
    },
    lastSyncError: { type: String },
    connectedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// One connection per Business — reconnecting overwrites (upsert), never creates a second row.
googleCalendarIntegrationSchema.index({ businessId: 1 }, { unique: true });

export const GoogleCalendarIntegrationModel = model<GoogleCalendarIntegrationDocument>(
  "GoogleCalendarIntegration",
  googleCalendarIntegrationSchema,
);
