import type { ClientSession, Types } from "mongoose";

import {
  type CustomerProfileDocument,
  CustomerProfileModel,
  type UserDocument,
  UserModel,
  type UserProfileDocument,
  UserProfileModel,
} from "./user.model.js";
import type { UserRole, UserStatus } from "./user.types.js";

type CreateUserInput = {
  normalizedEmail: string;
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  emailVerifiedAt?: Date | undefined;
  phoneVerifiedAt?: Date | undefined;
};

type CreateProfileInput = {
  userId: Types.ObjectId;
  firstName: string;
  lastName: string;
  gender: "male" | "female" | "other";
  phone: {
    countryCode: string;
    nationalNumber: string;
    e164: string;
  };
  termsAcceptedAt?: Date | undefined;
  termsVersion?: string | undefined;
};

export class UserRepository {
  public async findByEmail(normalizedEmail: string): Promise<UserDocument | null> {
    return UserModel.findOne({ normalizedEmail }).exec();
  }

  public async findByEmailWithPassword(normalizedEmail: string): Promise<UserDocument | null> {
    return UserModel.findOne({ normalizedEmail }).select("+passwordHash").exec();
  }

  public async findById(id: Types.ObjectId | string): Promise<UserDocument | null> {
    return UserModel.findById(id).exec();
  }

  public async create(input: CreateUserInput, session?: ClientSession): Promise<UserDocument> {
    return new UserModel({
      ...input,
      security: {
        passwordUpdatedAt: new Date(),
      },
    }).save(session ? { session } : undefined);
  }

  public async updateLastLogin(userId: Types.ObjectId): Promise<void> {
    await UserModel.updateOne({ _id: userId }, { $set: { "security.lastLoginAt": new Date() } });
  }

  public async createProfile(
    input: CreateProfileInput,
    session?: ClientSession,
  ): Promise<UserProfileDocument> {
    return new UserProfileModel(input).save(session ? { session } : undefined);
  }

  public async createCustomerProfile(
    userId: Types.ObjectId,
    input: Pick<CustomerProfileDocument, "address" | "dateOfBirth"> = {},
    session?: ClientSession,
  ): Promise<CustomerProfileDocument> {
    return new CustomerProfileModel({ userId, ...input }).save(session ? { session } : undefined);
  }

  public async findProfileByUserId(
    userId: Types.ObjectId | string,
  ): Promise<UserProfileDocument | null> {
    return UserProfileModel.findOne({ userId }).exec();
  }
}
