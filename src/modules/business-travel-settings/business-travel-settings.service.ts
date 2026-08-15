import { Types } from "mongoose";

import { BusinessError } from "../business/business.errors.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import {
  type BusinessCity,
  type BusinessVisitType,
  businessCities,
} from "../business/business.types.js";
import type { BusinessAccessRepository } from "../business/business-access.repository.js";
import { BusinessTravelSettingsError } from "./business-travel-settings.errors.js";
import type {
  BusinessTravelCitySetting,
  BusinessTravelSettingsDocument,
} from "./business-travel-settings.model.js";
import type { BusinessTravelSettingsRepository } from "./business-travel-settings.repository.js";

export type BusinessTravelCitySettingDto = {
  city: BusinessCity;
  active: boolean;
  feeCents: number;
};

export type BusinessTravelSettingsDto = {
  businessId: string;
  cities: BusinessTravelCitySettingDto[];
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export type TravelFeeResolution =
  | {
      status: "NOT_APPLICABLE";
      businessId: string;
      customerCity: BusinessCity;
      serviceDeliveryType: "AT_BUSINESS_LOCATION";
      travelFeeCents: 0;
      serviceSubtotalCents?: number | undefined;
      totalDueCents?: number | undefined;
      commissionableSubtotalCents?: number | undefined;
    }
  | {
      status: "NOT_SERVED";
      businessId: string;
      customerCity: BusinessCity;
      serviceDeliveryType: "TRAVEL_TO_CUSTOMER";
      travelFeeCents: 0;
      serviceSubtotalCents?: number | undefined;
      totalDueCents?: number | undefined;
      commissionableSubtotalCents?: number | undefined;
    }
  | {
      status: "SERVED";
      businessId: string;
      customerCity: BusinessCity;
      serviceDeliveryType: "TRAVEL_TO_CUSTOMER";
      travelFeeCents: number;
      serviceSubtotalCents?: number | undefined;
      totalDueCents?: number | undefined;
      commissionableSubtotalCents?: number | undefined;
    };

export class BusinessTravelSettingsService {
  public constructor(
    private readonly businessTravelSettingsRepository: BusinessTravelSettingsRepository,
    private readonly businessRepository: BusinessRepository,
    private readonly businessAccessRepository: BusinessAccessRepository,
  ) {}

  public async getBusinessTravelSettings(
    userId: string,
    businessId: string,
  ): Promise<BusinessTravelSettingsDto> {
    await this.requireReadableBusiness(userId, businessId);
    const settings = await this.businessTravelSettingsRepository.findByBusinessId(businessId);
    return this.toDto(businessId, settings);
  }

  public async updateBusinessTravelSettings(
    userId: string,
    businessId: string,
    cities: BusinessTravelCitySetting[],
  ): Promise<BusinessTravelSettingsDto> {
    await this.requireOwnedBusiness(userId, businessId);
    const settings = await this.businessTravelSettingsRepository.upsertByBusinessId(
      businessId,
      this.normalizeCitySettings(cities),
    );

    return this.toDto(businessId, settings);
  }

  public async resolveTravelFee(input: {
    businessId: string;
    customerCity: BusinessCity;
    serviceDeliveryType: BusinessVisitType;
    serviceSubtotalCents?: number | undefined;
  }): Promise<TravelFeeResolution> {
    this.requireValidTravelResolutionInput(input);
    await this.requireBusiness(input.businessId);

    if (input.serviceDeliveryType === "AT_BUSINESS_LOCATION") {
      return {
        status: "NOT_APPLICABLE",
        businessId: input.businessId,
        customerCity: input.customerCity,
        serviceDeliveryType: input.serviceDeliveryType,
        travelFeeCents: 0,
        ...this.buildPriceBreakdown(input.serviceSubtotalCents, 0),
      };
    }

    const settings = await this.businessTravelSettingsRepository.findByBusinessId(input.businessId);
    const city = settings?.cities.find((setting) => setting.city === input.customerCity);

    if (!city?.active) {
      return {
        status: "NOT_SERVED",
        businessId: input.businessId,
        customerCity: input.customerCity,
        serviceDeliveryType: input.serviceDeliveryType,
        travelFeeCents: 0,
        ...this.buildPriceBreakdown(input.serviceSubtotalCents, 0),
      };
    }

    return {
      status: "SERVED",
      businessId: input.businessId,
      customerCity: input.customerCity,
      serviceDeliveryType: input.serviceDeliveryType,
      travelFeeCents: city.feeCents,
      ...this.buildPriceBreakdown(input.serviceSubtotalCents, city.feeCents),
    };
  }

  private async requireReadableBusiness(
    userId: string,
    businessId: string,
  ): Promise<BusinessDocument> {
    const business = await this.requireBusiness(businessId);

    if (business.ownerUserId.equals(userId)) {
      return business;
    }

    const access = await this.businessAccessRepository.findByUserAndBusiness(userId, businessId);

    if (!access) {
      throw new BusinessError("BUSINESS_ACCESS_DENIED", 403);
    }

    return business;
  }

  private async requireOwnedBusiness(
    userId: string,
    businessId: string,
  ): Promise<BusinessDocument> {
    const business = await this.requireBusiness(businessId);

    if (!business.ownerUserId.equals(userId)) {
      throw new BusinessError("BUSINESS_NOT_FOUND", 404);
    }

    return business;
  }

  private async requireBusiness(businessId: string): Promise<BusinessDocument> {
    this.requireValidObjectId(businessId);
    const business = await this.businessRepository.findById(businessId);

    if (!business) {
      throw new BusinessError("BUSINESS_NOT_FOUND", 404);
    }

    return business;
  }

  private requireValidObjectId(id: string): void {
    if (!Types.ObjectId.isValid(id)) {
      throw new BusinessError("BUSINESS_NOT_FOUND", 404);
    }
  }

  private requireValidTravelResolutionInput(input: {
    businessId: string;
    customerCity: BusinessCity;
    serviceDeliveryType: BusinessVisitType;
    serviceSubtotalCents?: number | undefined;
  }): void {
    this.requireValidObjectId(input.businessId);

    if (!this.isBusinessCity(input.customerCity)) {
      throw new BusinessTravelSettingsError("BUSINESS_TRAVEL_SETTINGS_INVALID_CITY", 400);
    }

    if (!["AT_BUSINESS_LOCATION", "TRAVEL_TO_CUSTOMER"].includes(input.serviceDeliveryType)) {
      throw new BusinessTravelSettingsError("BUSINESS_TRAVEL_SETTINGS_INVALID_DELIVERY_TYPE", 400);
    }

    if (
      input.serviceSubtotalCents !== undefined &&
      (!Number.isInteger(input.serviceSubtotalCents) || input.serviceSubtotalCents < 0)
    ) {
      throw new BusinessTravelSettingsError(
        "BUSINESS_TRAVEL_SETTINGS_INVALID_SERVICE_SUBTOTAL",
        400,
      );
    }
  }

  private isBusinessCity(city: unknown): city is BusinessCity {
    return businessCities.includes(city as BusinessCity);
  }

  private normalizeCitySettings(cities: BusinessTravelCitySetting[]): BusinessTravelCitySetting[] {
    const byCity = new Map(cities.map((setting) => [setting.city, setting]));

    return businessCities.map((city) => {
      const setting = byCity.get(city);
      return {
        city,
        active: setting?.active ?? false,
        feeCents: setting?.feeCents ?? 0,
      };
    });
  }

  private toDto(
    businessId: string,
    settings: BusinessTravelSettingsDocument | null,
  ): BusinessTravelSettingsDto {
    return {
      businessId,
      cities: this.normalizeCitySettings(settings?.cities ?? []),
      createdAt: settings?.createdAt.toISOString(),
      updatedAt: settings?.updatedAt.toISOString(),
    };
  }

  private buildPriceBreakdown(
    serviceSubtotalCents: number | undefined,
    travelFeeCents: number,
  ):
    | {
        serviceSubtotalCents: number;
        totalDueCents: number;
        commissionableSubtotalCents: number;
      }
    | Record<string, never> {
    if (serviceSubtotalCents === undefined) {
      return {};
    }

    return {
      serviceSubtotalCents,
      totalDueCents: serviceSubtotalCents + travelFeeCents,
      commissionableSubtotalCents: serviceSubtotalCents,
    };
  }
}
