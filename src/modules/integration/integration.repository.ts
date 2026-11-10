import { randomUUID } from "node:crypto";
import type { Types } from "mongoose";

import {
  type GoogleCalendarIntegrationDocument,
  GoogleCalendarIntegrationModel,
} from "./integration.model.js";

export type UpsertGoogleCalendarIntegrationInput = {
  businessId: Types.ObjectId;
  googleAccountEmail: string;
  googleAccountId?: string;
  calendarId: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  tokenExpiresAt: Date;
};

export class IntegrationRepository {
  public async findByBusinessId(
    businessId: Types.ObjectId | string,
  ): Promise<GoogleCalendarIntegrationDocument | null> {
    return GoogleCalendarIntegrationModel.findOne({ businessId }).exec();
  }

  /** Reconnecting overwrites the existing row (unique {businessId:1} index) rather than
   * accumulating stale connections. */
  public async upsert(
    input: UpsertGoogleCalendarIntegrationInput,
  ): Promise<GoogleCalendarIntegrationDocument> {
    const now = new Date();

    return GoogleCalendarIntegrationModel.findOneAndUpdate(
      { businessId: input.businessId },
      {
        $set: {
          googleAccountEmail: input.googleAccountEmail,
          ...(input.googleAccountId ? { googleAccountId: input.googleAccountId } : {}),
          calendarId: input.calendarId,
          connectionGeneration: randomUUID(),
          encryptedAccessToken: input.encryptedAccessToken,
          encryptedRefreshToken: input.encryptedRefreshToken,
          tokenExpiresAt: input.tokenExpiresAt,
          status: "CONNECTED",
          connectedAt: now,
        },
        // P2.2.9 — a reconnect is a fresh connection: clear the previous failure markers.
        $unset: {
          lastSyncError: "",
          lastSyncFailedAt: "",
          ...(!input.googleAccountId ? { googleAccountId: "" } : {}),
        },
      },
      { upsert: true, returnDocument: "after", runValidators: true },
    ).exec() as Promise<GoogleCalendarIntegrationDocument>;
  }

  public async updateTokens(
    id: Types.ObjectId,
    tokens: { encryptedAccessToken: string; encryptedRefreshToken: string; tokenExpiresAt: Date },
    expectedGeneration?: string,
  ): Promise<boolean> {
    const result = await GoogleCalendarIntegrationModel.updateOne(
      { _id: id, connectionGeneration: expectedGeneration ?? { $exists: false } },
      { $set: tokens },
    ).exec();
    return result.matchedCount === 1;
  }

  /** Records a best-effort failure. Never downgrades RECONNECT_REQUIRED (that needs the Owner). */
  public async markSyncError(
    businessId: Types.ObjectId | string,
    message: string,
    generation?: string,
  ): Promise<void> {
    await GoogleCalendarIntegrationModel.updateOne(
      {
        businessId,
        status: { $ne: "RECONNECT_REQUIRED" },
        ...(generation ? { connectionGeneration: generation } : {}),
      },
      { $set: { status: "ERROR", lastSyncError: message, lastSyncFailedAt: new Date() } },
    ).exec();
  }

  /**
   * P2.2.9 — a confirmed Google write: records the time and clears a previous transient ERROR.
   * Fenced on the connection generation used for the call, and never clears RECONNECT_REQUIRED.
   */
  public async markSyncSucceeded(
    businessId: Types.ObjectId | string,
    generation?: string,
  ): Promise<void> {
    await GoogleCalendarIntegrationModel.updateOne(
      {
        businessId,
        status: { $ne: "RECONNECT_REQUIRED" },
        connectionGeneration: generation ?? { $exists: false },
      },
      {
        $set: { status: "CONNECTED", lastSyncSucceededAt: new Date() },
        $unset: { lastSyncError: "" },
      },
    ).exec();
  }

  /**
   * P2.2.9 — Google revoked/expired the grant. Fenced on the generation that failed, so an Owner
   * reconnect that already replaced the row is never marked broken by a stale attempt.
   */
  public async markReconnectRequired(id: Types.ObjectId, generation?: string): Promise<boolean> {
    const result = await GoogleCalendarIntegrationModel.updateOne(
      { _id: id, connectionGeneration: generation ?? { $exists: false } },
      {
        $set: {
          status: "RECONNECT_REQUIRED",
          lastSyncError: "GOOGLE_CALENDAR_RECONNECT_REQUIRED",
          lastSyncFailedAt: new Date(),
        },
      },
    ).exec();
    return result.matchedCount === 1;
  }

  public async deleteByBusinessId(businessId: Types.ObjectId | string): Promise<boolean> {
    const result = await GoogleCalendarIntegrationModel.deleteOne({ businessId }).exec();

    return result.deletedCount > 0;
  }
}
