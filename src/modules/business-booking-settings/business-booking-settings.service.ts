import { Types } from "mongoose";

import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import { BusinessBookingSettingsError } from "./business-booking-settings.errors.js";
import type { BusinessBookingSettingsDocument } from "./business-booking-settings.model.js";
import type { BusinessBookingSettingsRepository } from "./business-booking-settings.repository.js";

export type BusinessBookingSettingsDto = {
  businessId: string;
  gapEliminationEnabled: boolean;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export class BusinessBookingSettingsService {
  public constructor(
    private readonly businessBookingSettingsRepository: BusinessBookingSettingsRepository,
    private readonly businessRepository: BusinessRepository,
  ) {}

  public async getBookingSettings(
    userId: string,
    businessId: string,
  ): Promise<BusinessBookingSettingsDto> {
    await this.requireOwnedBusiness(userId, businessId);
    const settings = await this.businessBookingSettingsRepository.findByBusinessId(businessId);
    return this.toDto(businessId, settings);
  }

  public async updateBookingSettings(
    userId: string,
    businessId: string,
    gapEliminationEnabled: boolean,
  ): Promise<BusinessBookingSettingsDto> {
    await this.requireOwnedBusiness(userId, businessId);
    const settings = await this.businessBookingSettingsRepository.upsertByBusinessId(
      businessId,
      gapEliminationEnabled,
    );
    return this.toDto(businessId, settings);
  }

  // Owner-only, no BusinessAccess fallback — same rationale as Services (see
  // service.service.ts): booking settings are a management surface, not a shared read.
  private async requireOwnedBusiness(
    userId: string,
    businessId: string,
  ): Promise<BusinessDocument> {
    if (!Types.ObjectId.isValid(businessId)) {
      throw new BusinessBookingSettingsError("BUSINESS_BOOKING_SETTINGS_BUSINESS_NOT_FOUND", 404);
    }

    const business = await this.businessRepository.findById(businessId);

    if (!business) {
      throw new BusinessBookingSettingsError("BUSINESS_BOOKING_SETTINGS_BUSINESS_NOT_FOUND", 404);
    }

    if (!business.ownerUserId.equals(userId)) {
      throw new BusinessBookingSettingsError("BUSINESS_BOOKING_SETTINGS_BUSINESS_NOT_FOUND", 404);
    }

    return business;
  }

  private toDto(
    businessId: string,
    settings: BusinessBookingSettingsDocument | null,
  ): BusinessBookingSettingsDto {
    return {
      businessId,
      gapEliminationEnabled: settings?.gapEliminationEnabled ?? false,
      createdAt: settings?.createdAt.toISOString(),
      updatedAt: settings?.updatedAt.toISOString(),
    };
  }
}
