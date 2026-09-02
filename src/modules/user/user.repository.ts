import type { ClientSession, Types } from "mongoose";

import { zeroFilledMonths } from "../../common/time/analytics-buckets.js";
import {
  type CustomerAvatarMetadata,
  type CustomerProfileDocument,
  CustomerProfileModel,
  type UserDocument,
  UserModel,
  type UserProfileDocument,
  UserProfileModel,
} from "./user.model.js";
import type {
  MarketingEmailConsent,
  NotificationPreferences,
  UserLanguage,
  UserRole,
  UserStatus,
} from "./user.types.js";

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

  public async findByIdWithPassword(id: Types.ObjectId | string): Promise<UserDocument | null> {
    return UserModel.findById(id).select("+passwordHash").exec();
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

  /**
   * Stage M3A — one page of the marketing-campaign audience scan: UserProfile rows with
   * `notifications.marketingEmail === true`, ordered by `_id`, strictly after `afterId`. Uses
   * the partial index on `notifications.marketingEmail` (see user.model.ts). Returns only the
   * two fields the audience service needs. `_id`-cursor pagination — never `skip`/`offset`.
   */
  public async findMarketingOptedInProfilePage(
    afterId: Types.ObjectId | null,
    limit: number,
  ): Promise<Array<Pick<UserProfileDocument, "_id" | "userId">>> {
    const query: Record<string, unknown> = { "notifications.marketingEmail": true };
    if (afterId) {
      query["_id"] = { $gt: afterId };
    }
    return UserProfileModel.find(query, { _id: 1, userId: 1 })
      .sort({ _id: 1 })
      .limit(limit)
      .lean<Array<Pick<UserProfileDocument, "_id" | "userId">>>()
      .exec();
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

  /** Batch 18 — commits an OTP-verified email change. Unlike `updateEmail` (used by the Staff
   * email-change path, which never touches verification state), this always sets a fresh
   * `emailVerifiedAt` together with the new address in one update — required by the
   * `findVerifiedCustomerByEmail`/`ByPhoneE164` identity-linking invariant (client-identity.
   * service.ts): every value those queries can match against must genuinely be OTP-verified.
   * `normalizedEmail`'s unique index is the final race-safety net if two Customers verify the
   * same new email concurrently — the loser's update throws a duplicate-key error, surfaced by
   * the caller as EMAIL_ALREADY_REGISTERED. */
  public async commitEmailChange(userId: Types.ObjectId, normalizedEmail: string): Promise<void> {
    await UserModel.updateOne(
      { _id: userId },
      { $set: { normalizedEmail, emailVerifiedAt: new Date() } },
    );
  }

  public async updatePhoneVerifiedAt(userId: Types.ObjectId, verifiedAt: Date): Promise<void> {
    await UserModel.updateOne({ _id: userId }, { $set: { phoneVerifiedAt: verifiedAt } });
  }

  public async updateProfile(
    profileId: Types.ObjectId,
    update: Partial<Pick<CreateProfileInput, "firstName" | "lastName" | "gender">> & {
      /** `undefined` clears the phone (via $unset); omit the key entirely to leave it untouched. */
      phone?: CreateProfileInput["phone"];
      /** Account UI language preference (Super Admin Settings). */
      defaultLanguage?: UserLanguage;
      /** Partial nested update of the optional reminder channels: only the provided key(s) are
       * written, via a dot-path `$set` (`notifications.<channel>`), so toggling one channel
       * never clobbers the sibling. A dot-path set also auto-creates the sub-doc on a row that
       * never had one. */
      notifications?: NotificationPreferences;
      /** Stage M3A — audit provenance for a marketing-email preference change. Pass ONLY when
       * `notifications.marketingEmail` is also being written in the same call; the whole sub-doc
       * is replaced. */
      marketingEmailConsent?: MarketingEmailConsent;
    },
  ): Promise<void> {
    const { phone, notifications, marketingEmailConsent, ...rest } = update;
    const setFields: Record<string, unknown> = { ...rest };
    const unsetFields: Record<string, unknown> = {};

    if ("phone" in update) {
      if (phone) {
        setFields["phone"] = phone;
      } else {
        unsetFields["phone"] = "";
      }
    }

    if (notifications) {
      for (const [channel, value] of Object.entries(notifications)) {
        if (typeof value === "boolean") {
          setFields[`notifications.${channel}`] = value;
        }
      }
    }

    if (marketingEmailConsent) {
      setFields["marketingEmailConsent"] = marketingEmailConsent;
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

  public async findCustomerProfileByUserId(
    userId: Types.ObjectId | string,
  ): Promise<CustomerProfileDocument | null> {
    return CustomerProfileModel.findOne({ userId }).exec();
  }

  /** Batch 17 — Customer Profile edit. Upserts because CustomerProfile rows are never created at
   * signup (see createCustomerProfile — dormant until now); the first time a customer sets
   * address/dateOfBirth from their Profile page, the row must be created on the fly. */
  public async upsertCustomerProfile(
    userId: Types.ObjectId,
    update: Partial<Pick<CustomerProfileDocument, "address" | "dateOfBirth">>,
  ): Promise<void> {
    if (Object.keys(update).length === 0) {
      return;
    }

    await CustomerProfileModel.updateOne(
      { userId },
      { $set: update, $setOnInsert: { userId } },
      { upsert: true },
    );
  }

  /**
   * Customer avatar upload/replace. Upserts for the same reason as upsertCustomerProfile — the
   * CustomerProfile row may not exist yet the first time a customer sets a photo. Writes only
   * the storage reference; the bytes themselves live in the object store.
   */
  public async setCustomerAvatar(
    userId: Types.ObjectId | string,
    avatar: CustomerAvatarMetadata,
  ): Promise<void> {
    await CustomerProfileModel.updateOne(
      { userId },
      { $set: { avatar }, $setOnInsert: { userId } },
      { upsert: true },
    );
  }

  public async updatePasswordHash(userId: Types.ObjectId, passwordHash: string): Promise<void> {
    await UserModel.updateOne(
      { _id: userId },
      { $set: { passwordHash, "security.passwordUpdatedAt": new Date() } },
    );
  }

  /**
   * Account closure (soft delete). CAS-guarded on `status` not already being `"DELETED"`, so a
   * concurrent or replayed deletion matches zero documents (`matchedCount === 0`) and the caller
   * treats it as "already closed" — never a second anonymization. Frees `normalizedEmail` by
   * overwriting it with the caller-supplied deterministic, non-routable tombstone and replaces
   * `passwordHash` with an unusable value. Runs inside the deletion transaction via `session`.
   */
  public async softDeleteCustomer(
    userId: Types.ObjectId | string,
    input: {
      tombstoneEmail: string;
      unusablePasswordHash: string;
      deletedAt: Date;
      deletedBy: { actorUserId: Types.ObjectId; actorRole: UserRole };
      deletionReason?: string | undefined;
    },
    session?: ClientSession,
  ): Promise<{ matchedCount: number }> {
    const result = await UserModel.updateOne(
      { _id: userId, status: { $ne: "DELETED" } },
      {
        $set: {
          status: "DELETED",
          normalizedEmail: input.tombstoneEmail,
          passwordHash: input.unusablePasswordHash,
          "security.passwordUpdatedAt": input.deletedAt,
          deletedAt: input.deletedAt,
          deletedBy: input.deletedBy,
          ...(input.deletionReason ? { deletionReason: input.deletionReason } : {}),
        },
      },
      session ? { session } : undefined,
    );

    return { matchedCount: result.matchedCount ?? 0 };
  }

  /**
   * Anonymize the customer's UserProfile PII on account closure. `firstName`/`lastName`/`gender`
   * are required fields → overwritten with placeholders; the optional contact / preference
   * fields are removed. Runs inside the deletion transaction via `session`.
   */
  public async anonymizeUserProfileForDeletion(
    userId: Types.ObjectId | string,
    session?: ClientSession,
  ): Promise<void> {
    await UserProfileModel.updateOne(
      { userId },
      {
        $set: { firstName: "Deleted", lastName: "User", gender: "other" },
        $unset: { phone: "", notifications: "", marketingEmailConsent: "" },
      },
      session ? { session } : undefined,
    );
  }

  /**
   * Anonymize the customer's CustomerProfile PII on account closure. Every field here is
   * optional, so all are simply unset (the row itself may not exist — a no-op `updateOne` is
   * fine). The avatar object bytes are deleted from storage separately, post-commit.
   */
  public async anonymizeCustomerProfileForDeletion(
    userId: Types.ObjectId | string,
    session?: ClientSession,
  ): Promise<void> {
    await CustomerProfileModel.updateOne(
      { userId },
      { $unset: { address: "", dateOfBirth: "", avatar: "" } },
      session ? { session } : undefined,
    );
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
