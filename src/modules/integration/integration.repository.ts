import type { Types } from "mongoose";

import {
  type GoogleCalendarIntegrationDocument,
  GoogleCalendarIntegrationModel,
} from "./integration.model.js";

export type UpsertGoogleCalendarIntegrationInput = {
  businessId: Types.ObjectId;
  googleAccountEmail: string;
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
          calendarId: input.calendarId,
          encryptedAccessToken: input.encryptedAccessToken,
          encryptedRefreshToken: input.encryptedRefreshToken,
          tokenExpiresAt: input.tokenExpiresAt,
          status: "CONNECTED",
          connectedAt: now,
        },
        $unset: { lastSyncError: "" },
      },
      { upsert: true, returnDocument: "after", runValidators: true },
    ).exec() as Promise<GoogleCalendarIntegrationDocument>;
  }

  public async updateTokens(
    id: Types.ObjectId,
    tokens: { encryptedAccessToken: string; encryptedRefreshToken: string; tokenExpiresAt: Date },
  ): Promise<void> {
    await GoogleCalendarIntegrationModel.updateOne({ _id: id }, { $set: tokens }).exec();
  }

  public async markSyncError(businessId: Types.ObjectId | string, message: string): Promise<void> {
    await GoogleCalendarIntegrationModel.updateOne(
      { businessId },
      { $set: { status: "ERROR", lastSyncError: message } },
    ).exec();
  }

  public async deleteByBusinessId(businessId: Types.ObjectId | string): Promise<boolean> {
    const result = await GoogleCalendarIntegrationModel.deleteOne({ businessId }).exec();

    return result.deletedCount > 0;
  }
}
