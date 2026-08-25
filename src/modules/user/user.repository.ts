import type { ClientSession, Types } from "mongoose";

import { zeroFilledMonths } from "../../common/time/analytics-buckets.js";
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
  phone?:
    | {
        countryCode: string;
        nationalNumber: string;
        e164: string;
      }
    | undefined;
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

  public async findManyByIds(ids: Array<Types.ObjectId | string>): Promise<UserDocument[]> {
    if (ids.length === 0) {
      return [];
    }

    return UserModel.find({ _id: { $in: ids } }).exec();
  }

  public async findProfilesByUserIds(
    userIds: Array<Types.ObjectId | string>,
  ): Promise<UserProfileDocument[]> {
    if (userIds.length === 0) {
      return [];
    }

    return UserProfileModel.find({ userId: { $in: userIds } }).exec();
  }

  /** Batch 11 — Super Admin global Customer list: bounded, server-side paginated, filtered by
   * the existing `{role:1, status:1}` index. `q` (email or name) is a best-effort
   * case-insensitive substring match against normalizedEmail directly, plus a first batched
   * lookup of matching UserProfile rows by name — two bounded queries, never a `$lookup`
   * aggregation or an unbounded scan. */
  public async listByRole(
    role: UserRole,
    filter: { status?: UserStatus | undefined; q?: string | undefined },
    pagination: { page: number; limit: number },
  ): Promise<{ users: UserDocument[]; total: number }> {
    const query: Record<string, unknown> = { role };
    if (filter.status) query["status"] = filter.status;

    if (filter.q) {
      const escaped = filter.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(escaped, "i");
      const matchingProfileUserIds = await UserProfileModel.find(
        { $or: [{ firstName: pattern }, { lastName: pattern }] },
        { userId: 1 },
      ).exec();
      query["$or"] = [
        { normalizedEmail: pattern },
        { _id: { $in: matchingProfileUserIds.map((p) => p.userId) } },
      ];
    }

    const skip = (pagination.page - 1) * pagination.limit;
    const [users, total] = await Promise.all([
      UserModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(pagination.limit).exec(),
      UserModel.countDocuments(query).exec(),
    ]);

    return { users, total };
  }

  /** Batch 11 — Super Admin dashboard's "Total Customers" card, one indexed `countDocuments`
   * over `{role:1, status:1}`. */
  public async countByRole(role: UserRole): Promise<number> {
    return UserModel.countDocuments({ role }).exec();
  }

  /** Batch 12 — Super Admin Recent Activity: newest-first registrations for one role, bounded. */
  public async findRecentlyCreated(role: UserRole, limit: number): Promise<UserDocument[]> {
    return UserModel.find({ role }, { normalizedEmail: 1, createdAt: 1 })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
  }

  /** Batch 12 — Customer Analytics "customers registered over time", monthly-bucketed on the
   * `{role:1, createdAt:-1}` index. */
  public async countCreatedByMonth(
    role: UserRole,
    from: Date,
    to: Date,
  ): Promise<Array<{ year: number; month: number; count: number }>> {
    const rows = await UserModel.aggregate<{ _id: { year: number; month: number }; count: number }>(
      [
        { $match: { role, createdAt: { $gte: from, $lt: to } } },
        {
          $group: {
            _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
            count: { $sum: 1 },
          },
        },
      ],
    ).exec();

    const countByKey = new Map(rows.map((row) => [`${row._id.year}-${row._id.month}`, row.count]));
    return zeroFilledMonths(from, to).map(({ year, month }) => ({
      year,
      month,
      count: countByKey.get(`${year}-${month}`) ?? 0,
    }));
  }

  public async updateRole(
    userId: Types.ObjectId,
    role: UserRole,
    session?: ClientSession,
  ): Promise<void> {
    await UserModel.updateOne(
      { _id: userId },
      { $set: { role } },
      session ? { session } : undefined,
    );
  }

  public async updateEmail(userId: Types.ObjectId, normalizedEmail: string): Promise<void> {
    await UserModel.updateOne({ _id: userId }, { $set: { normalizedEmail } });
  }

  public async updateProfile(
    profileId: Types.ObjectId,
    update: Partial<Pick<CreateProfileInput, "firstName" | "lastName">> & {
      /** `undefined` clears the phone (via $unset); omit the key entirely to leave it untouched. */
      phone?: CreateProfileInput["phone"];
    },
  ): Promise<void> {
    const { phone, ...rest } = update;
    const setFields: Record<string, unknown> = { ...rest };
    const unsetFields: Record<string, unknown> = {};

    if ("phone" in update) {
      if (phone) {
        setFields["phone"] = phone;
      } else {
        unsetFields["phone"] = "";
      }
    }

    await UserProfileModel.updateOne(
      { _id: profileId },
      {
        ...(Object.keys(setFields).length > 0 ? { $set: setFields } : {}),
        ...(Object.keys(unsetFields).length > 0 ? { $unset: unsetFields } : {}),
      },
    );
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

  /**
   * Client identity-linking building blocks (see client-identity.service.ts). "Verified" here
   * means the User row itself has emailVerifiedAt/phoneVerifiedAt set — Bookly's customer
   * signup flow requires both OTP steps before a CUSTOMER account exists, so every CUSTOMER is
   * verified on both signals by construction; these queries simply make that check explicit
   * rather than assuming it.
   */
  public async findVerifiedCustomerByEmail(normalizedEmail: string): Promise<UserDocument | null> {
    return UserModel.findOne({
      normalizedEmail,
      role: "CUSTOMER",
      emailVerifiedAt: { $exists: true },
    }).exec();
  }

  public async findVerifiedCustomerByPhoneE164(phoneE164: string): Promise<UserDocument | null> {
    const profile = await UserProfileModel.findOne({ "phone.e164": phoneE164 }).exec();

    if (!profile) {
      return null;
    }

    return UserModel.findOne({
      _id: profile.userId,
      role: "CUSTOMER",
      phoneVerifiedAt: { $exists: true },
    }).exec();
  }
}
