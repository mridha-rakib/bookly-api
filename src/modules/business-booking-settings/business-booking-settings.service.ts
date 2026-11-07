import { Types } from "mongoose";

import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import { BusinessBookingSettingsError } from "./business-booking-settings.errors.js";
import type { BusinessBookingSettingsDocument } from "./business-booking-settings.model.js";
import type { BusinessBookingSettingsRepository } from "./business-booking-settings.repository.js";
import {
  assessBusinessFeeTax,
  type BusinessFeeTaxBlocker,
  type BusinessTaxStatus,
  isBusinessTaxSetupComplete,
  type UpdateBusinessTaxSettingsBody,
} from "./business-tax-settings.js";

/** Owner-only view. `setupComplete` (configuration) is deliberately separate from
 * `feeVatCalculationEnabled` (whether Bookly can calculate VAT on this Business's fees). */
export type BusinessTaxSettingsDto = {
  businessId: string;
  status: BusinessTaxStatus;
  countryCode: "CY" | null;
  vatNumber: string | null;
  updatedAt: string | null;
  setupComplete: boolean;
  feeVatCalculationEnabled: false;
  feeVatBlocker: BusinessFeeTaxBlocker;
};

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

  public async getTaxSettings(userId: string, businessId: string): Promise<BusinessTaxSettingsDto> {
    await this.requireOwnedBusiness(userId, businessId);
    const settings = await this.businessBookingSettingsRepository.findByBusinessId(businessId);
    return this.toTaxDto(businessId, settings);
  }

  public async updateTaxSettings(
    userId: string,
    businessId: string,
    body: UpdateBusinessTaxSettingsBody,
  ): Promise<BusinessTaxSettingsDto> {
    await this.requireOwnedBusiness(userId, businessId);
    const settings = await this.businessBookingSettingsRepository.upsertTaxByBusinessId(
      businessId,
      body,
      userId,
    );
    return this.toTaxDto(businessId, settings);
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

  private toTaxDto(
    businessId: string,
    settings: BusinessBookingSettingsDocument | null,
  ): BusinessTaxSettingsDto {
    const tax = settings?.tax;
    return {
      businessId,
      status: tax?.status ?? "NOT_CONFIGURED",
      countryCode: tax?.countryCode ?? null,
      vatNumber: tax?.vatNumber ?? null,
      updatedAt: tax?.updatedAt.toISOString() ?? null,
      setupComplete: isBusinessTaxSetupComplete(tax),
      feeVatCalculationEnabled: false,
      feeVatBlocker: assessBusinessFeeTax(tax).blocker,
    };
  }
}
