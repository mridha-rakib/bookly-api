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
}
