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
        $unset: { lastSyncError: "", ...(!input.googleAccountId ? { googleAccountId: "" } : {}) },
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

  public async markSyncError(
    businessId: Types.ObjectId | string,
    message: string,
    generation?: string,
  ): Promise<void> {
    await GoogleCalendarIntegrationModel.updateOne(
      { businessId, ...(generation ? { connectionGeneration: generation } : {}) },
      { $set: { status: "ERROR", lastSyncError: message } },
    ).exec();
  }

  public async deleteByBusinessId(businessId: Types.ObjectId | string): Promise<boolean> {
    const result = await GoogleCalendarIntegrationModel.deleteOne({ businessId }).exec();

    return result.deletedCount > 0;
  }
}
