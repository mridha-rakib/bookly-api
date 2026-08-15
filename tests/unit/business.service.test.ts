import mongoose, { Types } from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { env } from "../../src/config/env.js";
import { sha256 } from "../../src/modules/auth/auth.utils.js";
import type { BusinessDocument } from "../../src/modules/business/business.model.js";
import type { BusinessRepository } from "../../src/modules/business/business.repository.js";
import type { UpdateBusinessBody } from "../../src/modules/business/business.schema.js";
import { BusinessService } from "../../src/modules/business/business.service.js";
import type { BusinessAccessRepository } from "../../src/modules/business/business-access.repository.js";
import type { BusinessLinkVerificationDocument } from "../../src/modules/business/business-link-verification.model.js";
import type { BusinessLinkVerificationRepository } from "../../src/modules/business/business-link-verification.repository.js";
import type { BusinessMediaDocument } from "../../src/modules/business-media/business-media.model.js";
import type { BusinessMediaRepository } from "../../src/modules/business-media/business-media.repository.js";
import type { StorageService } from "../../src/modules/storage/storage.service.js";
import type { UserRepository } from "../../src/modules/user/user.repository.js";
import type { EmailOtpProvider } from "../../src/modules/verification/email-otp.provider.js";

const hashLinkOtp = (normalizedEmail: string, code: string): string =>
  sha256(`business-link:${normalizedEmail}:${code}:${env.OTP_HASH_SECRET}`);

const buildBusiness = (overrides: Partial<BusinessDocument> = {}): BusinessDocument =>
  ({
    _id: new Types.ObjectId(),
    ownerUserId: new Types.ObjectId(),
    name: "Soho Vintage Barbers",
    ownerName: "Blake Owner",
    email: "owner@example.com",
    phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
    status: "PENDING",
    visitType: "AT_BUSINESS_LOCATION",
    address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
    briefDescription: "A great barbershop",
    category: "Wellness",
    subcategories: ["Barber"],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  }) as BusinessDocument;

const buildVerification = (
  overrides: Partial<BusinessLinkVerificationDocument> = {},
): BusinessLinkVerificationDocument =>
  ({
    _id: new Types.ObjectId(),
    requesterUserId: new Types.ObjectId(),
    targetUserId: new Types.ObjectId(),
    targetBusinessId: new Types.ObjectId(),
    normalizedEmail: "other@example.com",
    otpHash: hashLinkOtp("other@example.com", "1234"),
    otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    attempts: 0,
    resendTimestamps: [],
    sentAt: new Date(Date.now() - 5 * 60 * 1000),
    consumedAt: undefined,
    save: vi.fn(),
    ...overrides,
  }) as unknown as BusinessLinkVerificationDocument;

const buildBusinessMedia = (
  overrides: Partial<BusinessMediaDocument> = {},
): BusinessMediaDocument =>
  ({
    _id: new Types.ObjectId(),
    businessId: new Types.ObjectId(),
    storageKey: "businesses/test/media/profile.png",
    bucket: "test-media",
    role: "PROFILE",
    mimeType: "image/png",
    size: 9,
    sortOrder: 0,
    createdBy: new Types.ObjectId(),
    createdAt: new Date("2026-01-03T00:00:00.000Z"),
    updatedAt: new Date("2026-01-04T00:00:00.000Z"),
    ...overrides,
  }) as BusinessMediaDocument;

const createService = (
  overrides: {
    businessRepository?: Partial<BusinessRepository>;
    businessAccessRepository?: Partial<BusinessAccessRepository>;
    userRepository?: Partial<UserRepository>;
    businessLinkVerificationRepository?: Partial<BusinessLinkVerificationRepository>;
    emailOtpProvider?: Partial<EmailOtpProvider>;
    businessMediaRepository?: Partial<BusinessMediaRepository>;
    storageService?: Partial<StorageService>;
  } = {},
) => {
  const businessRepository = {
    create: vi.fn(),
    findByOwnerUserId: vi.fn(),
    findById: vi.fn(),
    findManyByIds: vi.fn().mockResolvedValue([]),
    updateOwnedById: vi.fn(),
    ...overrides.businessRepository,
  };
  const businessAccessRepository = {
    create: vi.fn(),
    findByUserAndBusiness: vi.fn().mockResolvedValue(null),
    listByUserId: vi.fn().mockResolvedValue([]),
    deleteByUserAndBusiness: vi.fn().mockResolvedValue(false),
    ...overrides.businessAccessRepository,
  };
  const userRepository = {
    findByEmail: vi.fn(),
    ...overrides.userRepository,
  };
  const businessLinkVerificationRepository = {
    create: vi.fn(),
    findByIdForRequester: vi.fn().mockResolvedValue(null),
    save: vi.fn(),
    markConsumed: vi.fn(),
    ...overrides.businessLinkVerificationRepository,
  };
  const emailOtpProvider = {
    sendOtp: vi.fn(),
    ...overrides.emailOtpProvider,
  };
  const businessMediaRepository = {
    listProfileByBusinessIds: vi.fn().mockResolvedValue([]),
    ...overrides.businessMediaRepository,
  };
  const storageService = {
    getObjectUrl: vi.fn(async ({ key }: { key: string }) => `https://media.example/${key}`),
    ...overrides.storageService,
  };

  const service = new BusinessService(
    businessRepository as unknown as BusinessRepository,
    businessAccessRepository as unknown as BusinessAccessRepository,
    userRepository as unknown as UserRepository,
    businessLinkVerificationRepository as unknown as BusinessLinkVerificationRepository,
    emailOtpProvider as unknown as EmailOtpProvider,
    businessMediaRepository as unknown as BusinessMediaRepository,
    storageService as unknown as StorageService,
  );

  return {
    service,
    businessRepository,
    businessAccessRepository,
    userRepository,
    businessLinkVerificationRepository,
    emailOtpProvider,
    businessMediaRepository,
    storageService,
  };
};

describe("BusinessService.getBusinessProfile", () => {
  it("returns the owned business as primary and linked businesses as secondary", async () => {
    const primary = buildBusiness();
    const secondaryBusiness = buildBusiness({ _id: new Types.ObjectId() });
    const { service, businessRepository, businessAccessRepository } = createService({
      businessRepository: {
        findByOwnerUserId: vi.fn().mockResolvedValue(primary),
        findManyByIds: vi.fn().mockResolvedValue([secondaryBusiness]),
      },
      businessAccessRepository: {
        listByUserId: vi
          .fn()
          .mockResolvedValue([{ businessId: secondaryBusiness._id } as unknown as never]),
      },
    });

    const result = await service.getBusinessProfile(String(primary.ownerUserId));

    expect(result.primary?.id).toBe(String(primary._id));
    expect(result.secondary).toHaveLength(1);
    expect(result.secondary[0]?.id).toBe(String(secondaryBusiness._id));
    expect(businessRepository.findByOwnerUserId).toHaveBeenCalledTimes(1);
    expect(businessAccessRepository.listByUserId).toHaveBeenCalledTimes(1);
  });

  it("adds PROFILE media to visible cards with one bounded media lookup", async () => {
    const primary = buildBusiness();
    const secondaryBusiness = buildBusiness({ _id: new Types.ObjectId() });
    const primaryMedia = buildBusinessMedia({
      businessId: primary._id,
      storageKey: "businesses/primary/media/profile.png",
    });
    const secondaryMedia = buildBusinessMedia({
      businessId: secondaryBusiness._id,
      storageKey: "businesses/secondary/media/profile.png",
    });
    const { service, businessMediaRepository, storageService } = createService({
      businessRepository: {
        findByOwnerUserId: vi.fn().mockResolvedValue(primary),
        findManyByIds: vi.fn().mockResolvedValue([secondaryBusiness]),
      },
      businessAccessRepository: {
        listByUserId: vi
          .fn()
          .mockResolvedValue([{ businessId: secondaryBusiness._id } as unknown as never]),
      },
      businessMediaRepository: {
        listProfileByBusinessIds: vi.fn().mockResolvedValue([primaryMedia, secondaryMedia]),
      },
    });

    const result = await service.getBusinessProfile(String(primary.ownerUserId));

    expect(result.primary?.profileMedia?.url).toBe(
      "https://media.example/businesses/primary/media/profile.png",
    );
    expect(result.secondary[0]?.profileMedia?.url).toBe(
      "https://media.example/businesses/secondary/media/profile.png",
    );
    expect(businessMediaRepository.listProfileByBusinessIds).toHaveBeenCalledTimes(1);
    expect(businessMediaRepository.listProfileByBusinessIds).toHaveBeenCalledWith([
      primary._id,
      secondaryBusiness._id,
    ]);
    expect(storageService.getObjectUrl).toHaveBeenCalledTimes(2);
  });

  it("excludes the primary business id from secondary even if a stray link exists", async () => {
    const primary = buildBusiness();
    const { service, businessRepository } = createService({
      businessRepository: {
        findByOwnerUserId: vi.fn().mockResolvedValue(primary),
        findManyByIds: vi.fn(),
      },
      businessAccessRepository: {
        listByUserId: vi.fn().mockResolvedValue([{ businessId: primary._id } as unknown as never]),
      },
    });

    const result = await service.getBusinessProfile(String(primary.ownerUserId));

    expect(result.secondary).toHaveLength(0);
    expect(businessRepository.findManyByIds).not.toHaveBeenCalled();
  });

  it("returns null primary when the user has no owned business", async () => {
    const { service } = createService();

    const result = await service.getBusinessProfile(String(new Types.ObjectId()));

    expect(result.primary).toBeNull();
    expect(result.secondary).toEqual([]);
  });
});

describe("BusinessService.getBusinessDetail", () => {
  it("returns OWNER relationship for the business owner without checking links", async () => {
    const business = buildBusiness();
    const { service, businessAccessRepository } = createService({
      businessRepository: { findById: vi.fn().mockResolvedValue(business) },
    });

    const detail = await service.getBusinessDetail(
      String(business.ownerUserId),
      String(business._id),
    );

    expect(detail.relationship).toBe("OWNER");
    expect(businessAccessRepository.findByUserAndBusiness).not.toHaveBeenCalled();
  });

  it("returns LINKED relationship when a BusinessAccess link exists", async () => {
    const business = buildBusiness();
    const viewerId = String(new Types.ObjectId());
    const { service } = createService({
      businessRepository: { findById: vi.fn().mockResolvedValue(business) },
      businessAccessRepository: {
        findByUserAndBusiness: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() } as never),
      },
    });

    const detail = await service.getBusinessDetail(viewerId, String(business._id));

    expect(detail.relationship).toBe("LINKED");
  });

  it("rejects with BUSINESS_ACCESS_DENIED when neither owner nor linked", async () => {
    const business = buildBusiness();
    const { service } = createService({
      businessRepository: { findById: vi.fn().mockResolvedValue(business) },
    });

    await expect(
      service.getBusinessDetail(String(new Types.ObjectId()), String(business._id)),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects with BUSINESS_NOT_FOUND for a missing business", async () => {
    const { service } = createService({
      businessRepository: { findById: vi.fn().mockResolvedValue(null) },
    });

    await expect(
      service.getBusinessDetail(String(new Types.ObjectId()), String(new Types.ObjectId())),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects with BUSINESS_NOT_FOUND for a malformed business id without querying the database", async () => {
    const { service, businessRepository } = createService();

    await expect(
      service.getBusinessDetail(String(new Types.ObjectId()), "not-an-object-id"),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(businessRepository.findById).not.toHaveBeenCalled();
  });
});

describe("BusinessService.updateOwnedBusiness", () => {
  it("builds a dot-notation $set and only includes provided fields", async () => {
    const business = buildBusiness();
    const { service, businessRepository } = createService({
      businessRepository: { updateOwnedById: vi.fn().mockResolvedValue(business) },
    });
    const input: UpdateBusinessBody = { name: "New Name", area: "New Area" };

    await service.updateOwnedBusiness(String(business.ownerUserId), String(business._id), input);

    expect(businessRepository.updateOwnedById).toHaveBeenCalledWith(
      String(business.ownerUserId),
      String(business._id),
      { name: "New Name", "address.area": "New Area" },
    );
  });

  it("rejects with BUSINESS_NOT_FOUND when the business is not owned by the caller", async () => {
    const { service } = createService({
      businessRepository: { updateOwnedById: vi.fn().mockResolvedValue(null) },
    });

    await expect(
      service.updateOwnedBusiness(String(new Types.ObjectId()), String(new Types.ObjectId()), {
        name: "X",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("BusinessService.requestLinkVerification", () => {
  it("issues a 4-digit OTP to the target account email and persists a challenge, without creating a link", async () => {
    const targetUser = { _id: new Types.ObjectId(), role: "BUSINESS_OWNER" };
    const targetBusiness = buildBusiness({ ownerUserId: targetUser._id });
    const currentUserId = String(new Types.ObjectId());
    const {
      service,
      businessLinkVerificationRepository,
      emailOtpProvider,
      businessAccessRepository,
    } = createService({
      userRepository: { findByEmail: vi.fn().mockResolvedValue(targetUser) },
      businessRepository: { findByOwnerUserId: vi.fn().mockResolvedValue(targetBusiness) },
      businessLinkVerificationRepository: {
        create: vi.fn().mockResolvedValue(
          buildVerification({
            requesterUserId: new Types.ObjectId(currentUserId),
            targetUserId: targetUser._id,
            targetBusinessId: targetBusiness._id,
          }),
        ),
      },
    });

    const result = await service.requestLinkVerification(currentUserId, "Other@Example.com ");

    expect(result.verificationId).toEqual(expect.any(String));
    expect(result.expiresAt).toEqual(expect.any(String));
    expect(result.resendAvailableAt).toEqual(expect.any(String));

    expect(businessLinkVerificationRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterUserId: new Types.ObjectId(currentUserId),
        targetUserId: targetUser._id,
        targetBusinessId: targetBusiness._id,
        normalizedEmail: "other@example.com",
      }),
    );
    expect(emailOtpProvider.sendOtp).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "other@example.com",
        code: expect.stringMatching(/^\d{4}$/),
        purpose: "BUSINESS_LINK",
      }),
    );
    expect(businessAccessRepository.create).not.toHaveBeenCalled();
  });

  it("rejects with BUSINESS_ACCOUNT_NOT_FOUND for a missing or non-Business-Owner email", async () => {
    const { service, businessLinkVerificationRepository } = createService({
      userRepository: { findByEmail: vi.fn().mockResolvedValue(null) },
    });

    await expect(
      service.requestLinkVerification(String(new Types.ObjectId()), "missing@example.com"),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(businessLinkVerificationRepository.create).not.toHaveBeenCalled();
  });

  it("rejects with CANNOT_LINK_OWN_BUSINESS when requesting verification for self", async () => {
    const selfUserId = new Types.ObjectId();
    const { service } = createService({
      userRepository: {
        findByEmail: vi.fn().mockResolvedValue({ _id: selfUserId, role: "BUSINESS_OWNER" }),
      },
    });

    await expect(
      service.requestLinkVerification(String(selfUserId), "me@example.com"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects with BUSINESS_ALREADY_LINKED when a link already exists", async () => {
    const targetUser = { _id: new Types.ObjectId(), role: "BUSINESS_OWNER" };
    const targetBusiness = buildBusiness({ ownerUserId: targetUser._id });
    const { service } = createService({
      userRepository: { findByEmail: vi.fn().mockResolvedValue(targetUser) },
      businessRepository: { findByOwnerUserId: vi.fn().mockResolvedValue(targetBusiness) },
      businessAccessRepository: {
        findByUserAndBusiness: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() } as never),
      },
    });

    await expect(
      service.requestLinkVerification(String(new Types.ObjectId()), "other@example.com"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("BusinessService.resendLinkVerification", () => {
  it("rejects with BUSINESS_LINK_VERIFICATION_NOT_FOUND when the challenge does not belong to the requester", async () => {
    const { service } = createService({
      businessLinkVerificationRepository: { findByIdForRequester: vi.fn().mockResolvedValue(null) },
    });

    await expect(
      service.resendLinkVerification(String(new Types.ObjectId()), String(new Types.ObjectId())),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects with BUSINESS_LINK_VERIFICATION_CONSUMED for an already-consumed challenge", async () => {
    const verification = buildVerification({ consumedAt: new Date() });
    const { service } = createService({
      businessLinkVerificationRepository: {
        findByIdForRequester: vi.fn().mockResolvedValue(verification),
      },
    });

    await expect(
      service.resendLinkVerification(
        String(verification.requesterUserId),
        String(verification._id),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects with OTP_RESEND_COOLDOWN when resending too soon", async () => {
    const targetUser = { _id: new Types.ObjectId(), role: "BUSINESS_OWNER" };
    const targetBusiness = buildBusiness({ ownerUserId: targetUser._id });
    const verification = buildVerification({ sentAt: new Date() });
    const { service } = createService({
      userRepository: { findByEmail: vi.fn().mockResolvedValue(targetUser) },
      businessRepository: { findByOwnerUserId: vi.fn().mockResolvedValue(targetBusiness) },
      businessLinkVerificationRepository: {
        findByIdForRequester: vi.fn().mockResolvedValue(verification),
      },
    });

    await expect(
      service.resendLinkVerification(
        String(verification.requesterUserId),
        String(verification._id),
      ),
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it("issues a fresh OTP, resets attempts, and sends only to the original target email", async () => {
    const targetUser = { _id: new Types.ObjectId(), role: "BUSINESS_OWNER" };
    const targetBusiness = buildBusiness({ ownerUserId: targetUser._id });
    const verification = buildVerification({
      sentAt: new Date(Date.now() - 10 * 60 * 1000),
      attempts: 3,
    });
    const { service, emailOtpProvider, businessLinkVerificationRepository } = createService({
      userRepository: { findByEmail: vi.fn().mockResolvedValue(targetUser) },
      businessRepository: { findByOwnerUserId: vi.fn().mockResolvedValue(targetBusiness) },
      businessLinkVerificationRepository: {
        findByIdForRequester: vi.fn().mockResolvedValue(verification),
      },
    });

    await service.resendLinkVerification(
      String(verification.requesterUserId),
      String(verification._id),
    );

    expect(verification.attempts).toBe(0);
    expect(businessLinkVerificationRepository.save).toHaveBeenCalledWith(verification);
    expect(emailOtpProvider.sendOtp).toHaveBeenCalledWith(
      expect.objectContaining({ to: verification.normalizedEmail, purpose: "BUSINESS_LINK" }),
    );
  });
});

describe("BusinessService.verifyLinkVerification", () => {
  const withMockedSession = () => {
    const fakeSession = {
      withTransaction: vi.fn(async (callback: () => Promise<void>) => {
        await callback();
      }),
      endSession: vi.fn(),
    };
    const spy = vi
      .spyOn(mongoose, "startSession")
      .mockResolvedValue(fakeSession as unknown as never);
    return { fakeSession, spy };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates exactly one BusinessAccess and consumes the challenge on correct OTP", async () => {
    const { spy } = withMockedSession();
    const targetUser = { _id: new Types.ObjectId(), role: "BUSINESS_OWNER" };
    const targetBusiness = buildBusiness({ ownerUserId: targetUser._id });
    const verification = buildVerification({
      normalizedEmail: "other@example.com",
      otpHash: hashLinkOtp("other@example.com", "4321"),
    });
    const { service, businessAccessRepository, businessLinkVerificationRepository } = createService(
      {
        userRepository: { findByEmail: vi.fn().mockResolvedValue(targetUser) },
        businessRepository: { findByOwnerUserId: vi.fn().mockResolvedValue(targetBusiness) },
        businessLinkVerificationRepository: {
          findByIdForRequester: vi.fn().mockResolvedValue(verification),
        },
      },
    );

    const result = await service.verifyLinkVerification(
      String(verification.requesterUserId),
      String(verification._id),
      "4321",
    );

    expect(result.id).toBe(String(targetBusiness._id));
    expect(businessAccessRepository.create).toHaveBeenCalledTimes(1);
    expect(businessAccessRepository.create).toHaveBeenCalledWith(
      { userId: verification.requesterUserId, businessId: targetBusiness._id },
      expect.anything(),
    );
    expect(businessLinkVerificationRepository.markConsumed).toHaveBeenCalledWith(
      verification._id,
      expect.anything(),
    );
    spy.mockRestore();
  });

  it("rejects with OTP_INVALID and increments attempts on a wrong code", async () => {
    const verification = buildVerification({ otpHash: hashLinkOtp("other@example.com", "4321") });
    const { service, businessLinkVerificationRepository, businessAccessRepository } = createService(
      {
        businessLinkVerificationRepository: {
          findByIdForRequester: vi.fn().mockResolvedValue(verification),
        },
      },
    );

    await expect(
      service.verifyLinkVerification(
        String(verification.requesterUserId),
        String(verification._id),
        "0000",
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(verification.attempts).toBe(1);
    expect(businessLinkVerificationRepository.save).toHaveBeenCalledWith(verification);
    expect(businessAccessRepository.create).not.toHaveBeenCalled();
  });

  it("rejects with OTP_EXPIRED once past otpExpiresAt", async () => {
    const verification = buildVerification({ otpExpiresAt: new Date(Date.now() - 1_000) });
    const { service } = createService({
      businessLinkVerificationRepository: {
        findByIdForRequester: vi.fn().mockResolvedValue(verification),
      },
    });

    await expect(
      service.verifyLinkVerification(
        String(verification.requesterUserId),
        String(verification._id),
        "1234",
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects with OTP_ATTEMPTS_EXCEEDED once the attempt limit is reached", async () => {
    const verification = buildVerification({ attempts: env.OTP_MAX_VERIFICATION_ATTEMPTS });
    const { service } = createService({
      businessLinkVerificationRepository: {
        findByIdForRequester: vi.fn().mockResolvedValue(verification),
      },
    });

    await expect(
      service.verifyLinkVerification(
        String(verification.requesterUserId),
        String(verification._id),
        "1234",
      ),
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it("rejects a consumed challenge without re-checking the OTP (no replay)", async () => {
    const verification = buildVerification({ consumedAt: new Date() });
    const { service } = createService({
      businessLinkVerificationRepository: {
        findByIdForRequester: vi.fn().mockResolvedValue(verification),
      },
    });

    await expect(
      service.verifyLinkVerification(
        String(verification.requesterUserId),
        String(verification._id),
        "4321",
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("translates a racing duplicate-key insert into BUSINESS_ALREADY_LINKED", async () => {
    const { spy } = withMockedSession();
    const targetUser = { _id: new Types.ObjectId(), role: "BUSINESS_OWNER" };
    const targetBusiness = buildBusiness({ ownerUserId: targetUser._id });
    const verification = buildVerification({
      normalizedEmail: "other@example.com",
      otpHash: hashLinkOtp("other@example.com", "4321"),
    });
    const { service } = createService({
      userRepository: { findByEmail: vi.fn().mockResolvedValue(targetUser) },
      businessRepository: { findByOwnerUserId: vi.fn().mockResolvedValue(targetBusiness) },
      businessLinkVerificationRepository: {
        findByIdForRequester: vi.fn().mockResolvedValue(verification),
      },
      businessAccessRepository: {
        create: vi.fn().mockRejectedValue({ code: 11000 }),
      },
    });

    await expect(
      service.verifyLinkVerification(
        String(verification.requesterUserId),
        String(verification._id),
        "4321",
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    spy.mockRestore();
  });
});

describe("BusinessService.unlinkBusiness", () => {
  it("deletes only the relationship and returns void on success", async () => {
    const { service, businessAccessRepository } = createService({
      businessAccessRepository: { deleteByUserAndBusiness: vi.fn().mockResolvedValue(true) },
    });

    await expect(
      service.unlinkBusiness(String(new Types.ObjectId()), String(new Types.ObjectId())),
    ).resolves.toBeUndefined();
    expect(businessAccessRepository.deleteByUserAndBusiness).toHaveBeenCalledTimes(1);
  });

  it("rejects with BUSINESS_LINK_NOT_FOUND when there is nothing to delete", async () => {
    const { service } = createService();

    await expect(
      service.unlinkBusiness(String(new Types.ObjectId()), String(new Types.ObjectId())),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
