import type { Types } from "mongoose";
import { AuthError } from "../auth/auth.errors.js";
import type { BusinessDetailsBody, CategorySelectionBody } from "../auth/auth.schema.js";
import { normalizePhoneNumber } from "../auth/auth.utils.js";
import type { BusinessVisitType } from "../business/business.types.js";
import { resolveCanonicalCategorySelection } from "../platform-settings/business-taxonomy.js";
import type { BusinessOnboardingRepository } from "./business-onboarding.repository.js";

export class BusinessOnboardingService {
  public constructor(private readonly repository: BusinessOnboardingRepository) {}

  public async saveVisitType(registrationSessionId: Types.ObjectId, visitType: BusinessVisitType) {
    return this.repository.upsertVisitType(registrationSessionId, visitType);
  }

  public async saveBusinessDetails(
    registrationSessionId: Types.ObjectId,
    input: BusinessDetailsBody,
  ) {
    const nationalNumber = input.nationalNumber ?? input.mobileNumber;

    if (!nationalNumber) {
      throw new AuthError("INVALID_REGISTRATION_STEP", 400, [
        {
          path: "mobileNumber",
          message: "Business phone number is required",
          code: "required",
        },
      ]);
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

  /**
   * The Zod schema (categorySelectionBodySchema) already validated that `selectedCategoryKey`
   * is a real category and every `selectedSubcategoryKeys` entry belongs to it — this derives
   * the canonical display labels server-side (never trusting a browser-supplied label) and
   * persists key + label together, so completion / discovery / the Business document can keep
   * reading a plain display string without re-resolving it themselves.
   */
  public async saveCategories(registrationSessionId: Types.ObjectId, input: CategorySelectionBody) {
    const resolved = resolveCanonicalCategorySelection({
      categoryKey: input.selectedCategoryKey,
      subcategoryKeys: input.selectedSubcategoryKeys,
    });

    return this.repository.saveCategorySelection(registrationSessionId, {
      categoryKey: resolved.categoryKey,
      category: resolved.categoryLabel,
      subcategoryKeys: resolved.subcategoryKeys,
      subcategories: resolved.subcategoryLabels,
    });
  }
}
