import mongoose, { type ClientSession, Types } from "mongoose";

import { resolveBusinessTimezone } from "../../common/time/timezone.js";
import { env } from "../../config/env.js";
import { AuthError } from "../auth/auth.errors.js";
import {
  addMinutes,
  addSeconds,
  assertOtpResendAllowed,
  generateNumericOtp,
  normalizeEmail,
  normalizePhoneNumber,
  pruneRecentTimestamps,
  safeCompare,
  sha256,
} from "../auth/auth.utils.js";
import type { BusinessMediaDocument } from "../business-media/business-media.model.js";
import type { BusinessMediaRepository } from "../business-media/business-media.repository.js";
import type { StorageService } from "../storage/storage.service.js";
import type { UserDocument } from "../user/user.model.js";
import type { UserRepository } from "../user/user.repository.js";
import type { EmailOtpProvider } from "../verification/email-otp.provider.js";
import { BusinessError } from "./business.errors.js";
import type { BusinessAddress, BusinessDocument } from "./business.model.js";
import type { BusinessRepository, CreateBusinessInput } from "./business.repository.js";
import type { UpdateBusinessBody } from "./business.schema.js";
import {
  type BusinessStatus,
  type BusinessVisitType,
  normalizeBusinessVisitType,
} from "./business.types.js";
import type { BusinessAccessRepository } from "./business-access.repository.js";
import type { BusinessLinkVerificationDocument } from "./business-link-verification.model.js";
import type { BusinessLinkVerificationRepository } from "./business-link-verification.repository.js";

const oneHourMs = 60 * 60 * 1000;

export type BusinessCardDto = {
  id: string;
  name: string;
  status: BusinessStatus;
  visitType: BusinessVisitType;
  category: string;
  subcategories: string[];
  address: { city: string; area: string };
  profileMedia?: BusinessProfileMediaDto | undefined;
  createdAt: string;
};

export type BusinessProfileMediaDto = {
  id: string;
  url: string;
  mimeType: string;
  size: number;
  createdAt: string;
  updatedAt: string;
};

export type BusinessDetailDto = {
  id: string;
  name: string;
  ownerName: string;
  status: BusinessStatus;
  visitType: BusinessVisitType;
  timezone: string;
  phone: { countryCode: string; nationalNumber: string; e164: string };
  address: BusinessAddress;
  location?: { lat: number; lng: number; searchQuery?: string | undefined } | undefined;
  briefDescription: string;
  category: string;
  subcategories: string[];
  relationship: "OWNER" | "LINKED";
  createdAt: string;
  updatedAt: string;
};

export type BusinessProfileDto = {
  primary: BusinessCardDto | null;
  secondary: BusinessCardDto[];
};

export type BusinessLinkVerificationDto = {
  verificationId: string;
  expiresAt: string;
  resendAvailableAt: string;
};

export class BusinessService {
  public constructor(
    private readonly businessRepository: BusinessRepository,
    private readonly businessAccessRepository: BusinessAccessRepository,
    private readonly userRepository: UserRepository,
    private readonly businessLinkVerificationRepository: BusinessLinkVerificationRepository,
    private readonly emailOtpProvider: EmailOtpProvider,
    private readonly businessMediaRepository?: Pick<
      BusinessMediaRepository,
      "listProfileByBusinessIds"
    >,
    private readonly storageService?: Pick<StorageService, "getObjectUrl">,
  ) {}

  public async createOwnedBusiness(
    input: CreateBusinessInput,
    session?: ClientSession,
  ): Promise<BusinessDocument> {
    return this.businessRepository.create(input, session);
  }

  public async getBusinessProfile(ownerUserId: string): Promise<BusinessProfileDto> {
    const [primary, links] = await Promise.all([
      this.businessRepository.findByOwnerUserId(ownerUserId),
      this.businessAccessRepository.listByUserId(ownerUserId),
    ]);

    const secondaryIds = links
      .map((link) => link.businessId)
      .filter((businessId) => !primary || !businessId.equals(primary._id));

    const secondaryBusinesses =
      secondaryIds.length > 0 ? await this.businessRepository.findManyByIds(secondaryIds) : [];
    const visibleBusinesses = [primary, ...secondaryBusinesses].filter(
      (business): business is BusinessDocument => Boolean(business),
    );
    const profileMediaByBusinessId = await this.getProfileMediaByBusinessId(visibleBusinesses);

    return {
      primary: primary
        ? this.toCardDto(primary, profileMediaByBusinessId.get(String(primary._id)))
        : null,
      secondary: secondaryBusinesses.map((business) =>
        this.toCardDto(business, profileMediaByBusinessId.get(String(business._id))),
      ),
    };
  }

  public async getBusinessDetail(userId: string, businessId: string): Promise<BusinessDetailDto> {
    const business = await this.requireBusiness(businessId);

    if (business.ownerUserId.equals(userId)) {
      return this.toDetailDto(business, "OWNER");
    }

    const link = await this.businessAccessRepository.findByUserAndBusiness(userId, businessId);

    if (!link) {
      throw new BusinessError("BUSINESS_ACCESS_DENIED", 403);
    }

    return this.toDetailDto(business, "LINKED");
  }

  public async updateOwnedBusiness(
    ownerUserId: string,
    businessId: string,
    input: UpdateBusinessBody,
  ): Promise<BusinessDetailDto> {
    this.requireValidObjectId(businessId);

    const updated = await this.businessRepository.updateOwnedById(
      ownerUserId,
      businessId,
      this.buildUpdate(input),
    );

    if (!updated) {
      throw new BusinessError("BUSINESS_NOT_FOUND", 404);
    }

    return this.toDetailDto(updated, "OWNER");
  }

  /**
   * Step 1 of the linking flow: resolves + validates the target account, issues a 4-digit
   * OTP to the entered email, and persists a BusinessLinkVerification challenge. No
   * BusinessAccess is created here — that only happens after {@link verifyLinkVerification}.
   */
  public async requestLinkVerification(
    currentUserId: string,
    email: string,
  ): Promise<BusinessLinkVerificationDto> {
    const { targetUser, targetBusiness, normalizedEmail } = await this.resolveLinkTarget(
      currentUserId,
      email,
    );

    const now = new Date();
    const code = generateNumericOtp(env.OTP_LENGTH);
    const otpExpiresAt = addMinutes(now, env.OTP_EXPIRY_MINUTES);

    const verification = await this.businessLinkVerificationRepository.create({
      requesterUserId: new Types.ObjectId(currentUserId),
      targetUserId: targetUser._id,
      targetBusinessId: targetBusiness._id,
      normalizedEmail,
      otpHash: this.hashLinkOtp(normalizedEmail, code),
      otpExpiresAt,
      sentAt: now,
    });

    await this.emailOtpProvider.sendOtp({ to: normalizedEmail, code, purpose: "BUSINESS_LINK" });

    return this.toVerificationDto(verification, now);
  }

  /** Resends a new OTP for an existing, still-pending challenge to its original target email. */
  public async resendLinkVerification(
    currentUserId: string,
    verificationId: string,
  ): Promise<BusinessLinkVerificationDto> {
    const verification = await this.requireVerification(currentUserId, verificationId);

    // Re-validate the relationship is still linkable before spending a new OTP.
    await this.resolveLinkTarget(currentUserId, verification.normalizedEmail);

    assertOtpResendAllowed(verification.resendTimestamps, verification.sentAt);

    const now = new Date();
    const code = generateNumericOtp(env.OTP_LENGTH);
    verification.otpHash = this.hashLinkOtp(verification.normalizedEmail, code);
    verification.otpExpiresAt = addMinutes(now, env.OTP_EXPIRY_MINUTES);
    verification.attempts = 0;
    verification.sentAt = now;
    verification.resendTimestamps = pruneRecentTimestamps(
      [...verification.resendTimestamps, now],
      oneHourMs,
    );
    await this.businessLinkVerificationRepository.save(verification);

    await this.emailOtpProvider.sendOtp({
      to: verification.normalizedEmail,
      code,
      purpose: "BUSINESS_LINK",
    });

    return this.toVerificationDto(verification, now);
  }

  /**
   * Step 2: verifies the OTP and, only on success, creates the BusinessAccess relationship
   * and consumes the challenge in one transaction. The BusinessAccess unique
   * {userId,businessId} index is the authoritative backstop against concurrent double-verify.
   */
  public async verifyLinkVerification(
    currentUserId: string,
    verificationId: string,
    code: string,
  ): Promise<BusinessCardDto> {
    const verification = await this.requireVerification(currentUserId, verificationId);

    if (!verification.otpHash || verification.otpExpiresAt <= new Date()) {
      throw new AuthError("OTP_EXPIRED", 400);
    }

    if (verification.attempts >= env.OTP_MAX_VERIFICATION_ATTEMPTS) {
      throw new AuthError("OTP_ATTEMPTS_EXCEEDED", 429);
    }

    const submittedHash = this.hashLinkOtp(verification.normalizedEmail, code);

    if (!safeCompare(submittedHash, verification.otpHash)) {
      verification.attempts += 1;
      await this.businessLinkVerificationRepository.save(verification);
      throw new AuthError("OTP_INVALID", 400);
    }

    // Re-validate right before creating the link: the target/self/duplicate state can have
    // changed since the code was requested.
    const { targetBusiness } = await this.resolveLinkTarget(
      currentUserId,
      verification.normalizedEmail,
    );

    const dbSession = await mongoose.startSession();
    try {
      await dbSession.withTransaction(async () => {
        await this.businessAccessRepository.create(
          { userId: new Types.ObjectId(currentUserId), businessId: targetBusiness._id },
          dbSession,
        );
        await this.businessLinkVerificationRepository.markConsumed(verification._id, dbSession);
      });
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        throw new BusinessError("BUSINESS_ALREADY_LINKED", 409);
      }

      throw error;
    } finally {
      await dbSession.endSession();
    }

    return this.toCardDto(targetBusiness);
  }

  public async unlinkBusiness(userId: string, businessId: string): Promise<void> {
    this.requireValidObjectId(businessId);

    const deleted = await this.businessAccessRepository.deleteByUserAndBusiness(userId, businessId);

    if (!deleted) {
      throw new BusinessError("BUSINESS_LINK_NOT_FOUND", 404);
    }
  }

  private async resolveLinkTarget(
    currentUserId: string,
    email: string,
  ): Promise<{
    targetUser: UserDocument;
    targetBusiness: BusinessDocument;
    normalizedEmail: string;
  }> {
    const normalizedEmail = normalizeEmail(email);
    const targetUser = await this.userRepository.findByEmail(normalizedEmail);

    if (targetUser?.role !== "BUSINESS_OWNER") {
      throw new BusinessError("BUSINESS_ACCOUNT_NOT_FOUND", 404);
    }

    if (String(targetUser._id) === String(currentUserId)) {
      throw new BusinessError("CANNOT_LINK_OWN_BUSINESS", 409);
    }

    const targetBusiness = await this.businessRepository.findByOwnerUserId(targetUser._id);

    if (!targetBusiness) {
      throw new BusinessError("BUSINESS_ACCOUNT_NOT_FOUND", 404);
    }

    const existingLink = await this.businessAccessRepository.findByUserAndBusiness(
      currentUserId,
      targetBusiness._id,
    );

    if (existingLink) {
      throw new BusinessError("BUSINESS_ALREADY_LINKED", 409);
    }

    return { targetUser, targetBusiness, normalizedEmail };
  }

  private async requireVerification(
    currentUserId: string,
    verificationId: string,
  ): Promise<BusinessLinkVerificationDocument> {
    const verification = await this.businessLinkVerificationRepository.findByIdForRequester(
      verificationId,
      currentUserId,
    );

    if (!verification) {
      throw new BusinessError("BUSINESS_LINK_VERIFICATION_NOT_FOUND", 404);
    }

    if (verification.consumedAt) {
      throw new BusinessError("BUSINESS_LINK_VERIFICATION_CONSUMED", 409);
    }

    return verification;
  }

  private hashLinkOtp(normalizedEmail: string, code: string): string {
    return sha256(`business-link:${normalizedEmail}:${code}:${env.OTP_HASH_SECRET}`);
  }

  private toVerificationDto(
    verification: BusinessLinkVerificationDocument,
    now: Date,
  ): BusinessLinkVerificationDto {
    return {
      verificationId: String(verification._id),
      expiresAt: verification.otpExpiresAt.toISOString(),
      resendAvailableAt: addSeconds(now, env.OTP_RESEND_COOLDOWN_SECONDS).toISOString(),
    };
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

  private buildUpdate(input: UpdateBusinessBody): Record<string, unknown> {
    const update: Record<string, unknown> = {};

    if (input.name !== undefined) update["name"] = input.name;
    if (input.ownerName !== undefined) update["ownerName"] = input.ownerName;
    if (input.visitType !== undefined) update["visitType"] = input.visitType;
    if (input.timezone !== undefined) update["timezone"] = input.timezone;
    if (input.briefDescription !== undefined) update["briefDescription"] = input.briefDescription;
    if (input.category !== undefined) update["category"] = input.category;
    if (input.subcategories !== undefined) update["subcategories"] = input.subcategories;

    if (input.countryCode !== undefined && input.nationalNumber !== undefined) {
      update["phone"] = normalizePhoneNumber(input.countryCode, input.nationalNumber);
    }

    if (input.city !== undefined) update["address.city"] = input.city;
    if (input.area !== undefined) update["address.area"] = input.area;
    if (input.streetName !== undefined) update["address.streetName"] = input.streetName;
    if (input.streetNumber !== undefined) update["address.streetNumber"] = input.streetNumber;
    if (input.floorUnit !== undefined) update["address.floorUnit"] = input.floorUnit;
    if (input.aptRoom !== undefined) update["address.aptRoom"] = input.aptRoom;

    if (input.coordinates !== undefined) {
      update["location.lat"] = input.coordinates.lat;
      update["location.lng"] = input.coordinates.lng;
    }

    if (input.searchQuery !== undefined) {
      update["location.searchQuery"] = input.searchQuery;
    }

    return update;
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000
    );
  }

  private async getProfileMediaByBusinessId(
    businesses: BusinessDocument[],
  ): Promise<Map<string, BusinessProfileMediaDto>> {
    if (!this.businessMediaRepository || !this.storageService || businesses.length === 0) {
      return new Map();
    }

    const media = await this.businessMediaRepository.listProfileByBusinessIds(
      businesses.map((business) => business._id),
    );
    const entries = await Promise.all(
      media.map(
        async (item) => [String(item.businessId), await this.toProfileMediaDto(item)] as const,
      ),
    );

    return new Map(entries);
  }

  private async toProfileMediaDto(media: BusinessMediaDocument): Promise<BusinessProfileMediaDto> {
    return {
      id: String(media._id),
      url: (await this.storageService?.getObjectUrl({ key: media.storageKey })) ?? "",
      mimeType: media.mimeType,
      size: media.size,
      createdAt: media.createdAt.toISOString(),
      updatedAt: media.updatedAt.toISOString(),
    };
  }

  private toCardDto(
    business: BusinessDocument,
    profileMedia?: BusinessProfileMediaDto,
  ): BusinessCardDto {
    return {
      id: String(business._id),
      name: business.name,
      status: business.status,
      visitType: normalizeBusinessVisitType(business.visitType),
      category: business.category,
      subcategories: business.subcategories,
      address: { city: business.address.city, area: business.address.area },
      profileMedia,
      createdAt: business.createdAt.toISOString(),
    };
  }

  private toDetailDto(
    business: BusinessDocument,
    relationship: "OWNER" | "LINKED",
  ): BusinessDetailDto {
    return {
      id: String(business._id),
      name: business.name,
      ownerName: business.ownerName,
      status: business.status,
      visitType: normalizeBusinessVisitType(business.visitType),
      timezone: resolveBusinessTimezone(business.timezone),
      phone: business.phone,
      address: business.address,
      location: business.location,
      briefDescription: business.briefDescription,
      category: business.category,
      subcategories: business.subcategories,
      relationship,
      createdAt: business.createdAt.toISOString(),
      updatedAt: business.updatedAt.toISOString(),
    };
  }
}
