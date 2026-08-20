import type { ClientSession, Types } from "mongoose";

import { type BusinessDocument, BusinessModel } from "./business.model.js";
import type { BusinessVisitType } from "./business.types.js";

export type CreateBusinessInput = {
  ownerUserId: Types.ObjectId;
  name: string;
  ownerName: string;
  email: string;
  phone: {
    countryCode: string;
    nationalNumber: string;
    e164: string;
  };
  visitType: BusinessVisitType;
  /** Omitted by every current caller — the schema default (Europe/Nicosia) applies. Typed here
   * so a future onboarding step can supply it explicitly without a repository signature change. */
  timezone?: string;
  address: {
    city: string;
    area: string;
    streetName: string;
    streetNumber: string;
    floorUnit?: string | undefined;
    aptRoom?: string | undefined;
  };
  location?: {
    lat: number;
    lng: number;
    searchQuery?: string | undefined;
  };
  briefDescription: string;
  category: string;
  subcategories: string[];
};

export class BusinessRepository {
  public async create(
    input: CreateBusinessInput,
    session?: ClientSession,
  ): Promise<BusinessDocument> {
    return new BusinessModel({ ...input, status: "PENDING" }).save(
      session ? { session } : undefined,
    );
  }

  public async findByOwnerUserId(
    ownerUserId: Types.ObjectId | string,
  ): Promise<BusinessDocument | null> {
    return BusinessModel.findOne({ ownerUserId }).exec();
  }

  public async findById(businessId: Types.ObjectId | string): Promise<BusinessDocument | null> {
    return BusinessModel.findById(businessId).exec();
  }

  public async findManyByIds(
    businessIds: Array<Types.ObjectId | string>,
  ): Promise<BusinessDocument[]> {
    if (businessIds.length === 0) {
      return [];
    }

    return BusinessModel.find({ _id: { $in: businessIds } }).exec();
  }

  public async updateOwnedById(
    ownerUserId: Types.ObjectId | string,
    businessId: Types.ObjectId | string,
    update: Record<string, unknown>,
  ): Promise<BusinessDocument | null> {
    return BusinessModel.findOneAndUpdate(
      { _id: businessId, ownerUserId },
      { $set: update },
      { returnDocument: "after", runValidators: true },
    ).exec();
  }
}
