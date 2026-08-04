import type { Types } from "mongoose";
import type { BusinessDetailsBody, CategorySelectionBody } from "../auth/auth.schema.js";
import { normalizePhoneNumber } from "../auth/auth.utils.js";
import type { BusinessOnboardingRepository } from "./business-onboarding.repository.js";

export class BusinessOnboardingService {
  public constructor(private readonly repository: BusinessOnboardingRepository) {}

  public async saveVisitType(
    registrationSessionId: Types.ObjectId,
    visitType: "location" | "travel",
  ) {
    return this.repository.upsertVisitType(registrationSessionId, visitType);
  }

  public async saveBusinessDetails(
    registrationSessionId: Types.ObjectId,
    input: BusinessDetailsBody,
  ) {
    const nationalNumber = input.nationalNumber ?? input.mobileNumber;

    if (!nationalNumber) {
      throw new Error("Business phone number is required");
    }

    const address = {
      area: input.area,
      streetName: input.streetName,
      streetNumber: input.streetNumber,
      ...(input.floorUnit ? { floorUnit: input.floorUnit } : {}),
      ...(input.aptRoom ? { aptRoom: input.aptRoom } : {}),
    };
    const location = input.coordinates
      ? {
          lat: input.coordinates.lat,
          lng: input.coordinates.lng,
          ...(input.searchQuery ? { searchQuery: input.searchQuery } : {}),
        }
      : undefined;

    return this.repository.saveBusinessDetails(registrationSessionId, {
      businessName: input.businessName,
      ownerName: input.ownerName,
      city: input.city,
      phone: normalizePhoneNumber(input.countryCode, nationalNumber),
      address,
      ...(location ? { location } : {}),
      briefDescription: input.briefDesc,
    });
  }

  public async saveCategories(registrationSessionId: Types.ObjectId, input: CategorySelectionBody) {
    return this.repository.saveCategorySelection(registrationSessionId, {
      category: input.selectedCategory,
      subcategories: input.selectedSubcategories,
    });
  }
}
