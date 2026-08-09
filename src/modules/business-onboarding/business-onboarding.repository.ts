import type { Types } from "mongoose";

import type { BusinessVisitType } from "../business/business.types.js";
import {
  type BusinessOnboardingDraftDocument,
  BusinessOnboardingDraftModel,
} from "./business-onboarding.model.js";

export class BusinessOnboardingRepository {
  public async upsertVisitType(
    registrationSessionId: Types.ObjectId,
    visitType: BusinessVisitType,
  ): Promise<BusinessOnboardingDraftDocument> {
    return BusinessOnboardingDraftModel.findOneAndUpdate(
      { registrationSessionId },
      { $set: { visitType } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    ).orFail();
  }

  public async saveBusinessDetails(
    registrationSessionId: Types.ObjectId,
    businessDetails: NonNullable<BusinessOnboardingDraftDocument["businessDetails"]>,
  ): Promise<BusinessOnboardingDraftDocument> {
    return BusinessOnboardingDraftModel.findOneAndUpdate(
      { registrationSessionId },
      { $set: { businessDetails } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    ).orFail();
  }

  public async saveCategorySelection(
    registrationSessionId: Types.ObjectId,
    categorySelection: NonNullable<BusinessOnboardingDraftDocument["categorySelection"]>,
  ): Promise<BusinessOnboardingDraftDocument> {
    return BusinessOnboardingDraftModel.findOneAndUpdate(
      { registrationSessionId },
      { $set: { categorySelection } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    ).orFail();
  }

  public async findByRegistrationSessionId(
    registrationSessionId: Types.ObjectId | string,
  ): Promise<BusinessOnboardingDraftDocument | null> {
    return BusinessOnboardingDraftModel.findOne({ registrationSessionId }).exec();
  }
}
