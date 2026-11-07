import { type ClientSession, Types } from "mongoose";

import {
  type BusinessBookingSettingsDocument,
  BusinessBookingSettingsModel,
} from "./business-booking-settings.model.js";
import type { UpdateBusinessTaxSettingsBody } from "./business-tax-settings.js";

export class BusinessBookingSettingsRepository {
  public async findByBusinessId(
    businessId: Types.ObjectId | string,
    session?: ClientSession,
  ): Promise<BusinessBookingSettingsDocument | null> {
    const query = BusinessBookingSettingsModel.findOne({ businessId });
    if (session) query.session(session);
    return query.exec();
  }

  public async upsertByBusinessId(
    businessId: Types.ObjectId | string,
    gapEliminationEnabled: boolean,
  ): Promise<BusinessBookingSettingsDocument> {
    return BusinessBookingSettingsModel.findOneAndUpdate(
      { businessId },
      { $set: { gapEliminationEnabled } },
      {
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        upsert: true,
      },
    ).orFail();
  }

  /** Replaces only the tax sub-document; gap elimination is untouched (defaulted on insert). */
  public async upsertTaxByBusinessId(
    businessId: Types.ObjectId | string,
    tax: UpdateBusinessTaxSettingsBody,
    userId: string,
  ): Promise<BusinessBookingSettingsDocument> {
    return BusinessBookingSettingsModel.findOneAndUpdate(
      { businessId },
      {
        $set: {
          tax: {
            status: tax.status,
            countryCode: tax.countryCode,
            ...(tax.status === "VAT_REGISTERED" ? { vatNumber: tax.vatNumber } : {}),
            updatedAt: new Date(),
            updatedByUserId: new Types.ObjectId(userId),
          },
        },
      },
      { new: true, runValidators: true, setDefaultsOnInsert: true, upsert: true },
    ).orFail();
  }
}
