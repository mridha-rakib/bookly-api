import type { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BusinessError } from "../../../src/modules/business/business.errors.js";
import { BusinessModel } from "../../../src/modules/business/business.model.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessService } from "../../../src/modules/business/business.service.js";
import { BusinessAccessModel } from "../../../src/modules/business/business-access.model.js";
import { BusinessAccessRepository } from "../../../src/modules/business/business-access.repository.js";
import { BusinessLinkVerificationModel } from "../../../src/modules/business/business-link-verification.model.js";
import { BusinessLinkVerificationRepository } from "../../../src/modules/business/business-link-verification.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import type { EmailOtpProvider } from "../../../src/modules/verification/email-otp.provider.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

type DbIndex = {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
  expireAfterSeconds?: number;
};

const indexesFor = async (
  model: typeof BusinessModel | typeof BusinessAccessModel | typeof BusinessLinkVerificationModel,
) => (await model.collection.indexes()) as DbIndex[];

const businessInput = (ownerUserId: Types.ObjectId, name: string) => ({
  ownerUserId,
  name,
  ownerName: "Blake Owner",
  email: "owner@example.com",
  phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
  visitType: "AT_BUSINESS_LOCATION" as const,
  address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
  briefDescription: "A great business",
  category: "Wellness",
  subcategories: ["Massage"],
});

class CapturingEmailOtpProvider implements EmailOtpProvider {
  public lastCode = "";
  public lastTo = "";
  public sentCount = 0;

  public async sendOtp(input: { to: string; code: string }): Promise<void> {
    this.lastCode = input.code;
    this.lastTo = input.to;
    this.sentCount += 1;
  }
}

describe("database-backed Business and BusinessAccess integration", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let businessAccessRepository: BusinessAccessRepository;
  let businessLinkVerificationRepository: BusinessLinkVerificationRepository;
  let emailProvider: CapturingEmailOtpProvider;
  let businessService: BusinessService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    businessAccessRepository = new BusinessAccessRepository();
    businessLinkVerificationRepository = new BusinessLinkVerificationRepository();
    emailProvider = new CapturingEmailOtpProvider();
    businessService = new BusinessService(
      businessRepository,
      businessAccessRepository,
      userRepository,
      businessLinkVerificationRepository,
      emailProvider,
    );
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const createBusinessOwner = async (email: string, businessName: string) => {
    const user = await userRepository.create({
      normalizedEmail: email,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const business = await businessRepository.create(businessInput(user._id, businessName));
    return { user, business };
  };

  /** Drives the full request -> verify handshake and returns the resulting Secondary DTO. */
  const linkBusinessByEmail = async (currentUserId: string, targetEmail: string) => {
    await businessService.requestLinkVerification(currentUserId, targetEmail);
    const verification = await BusinessLinkVerificationModel.findOne({
      requesterUserId: currentUserId,
    })
      .sort({ createdAt: -1 })
      .orFail();
    return businessService.verifyLinkVerification(
      currentUserId,
      String(verification._id),
      emailProvider.lastCode,
    );
  };

  it("enforces one owned Business per Business Owner at the database level", async () => {
    const indexes = await indexesFor(BusinessModel);
    expect(indexes.some((index) => index.key["ownerUserId"] === 1 && index.unique === true)).toBe(
      true,
    );

    const { user } = await createBusinessOwner("owner-a@example.com", "Business A");

    await expect(
      businessRepository.create(businessInput(user._id, "Second Business")),
    ).rejects.toMatchObject({ code: 11000 });
    expect(await BusinessModel.countDocuments({ ownerUserId: user._id })).toBe(1);
  });

  it("enforces the unique {userId, businessId} constraint on BusinessAccess", async () => {
    const indexes = await indexesFor(BusinessAccessModel);
    expect(
      indexes.some(
        (index) =>
          index.key["userId"] === 1 && index.key["businessId"] === 1 && index.unique === true,
      ),
    ).toBe(true);

    const { user: userA } = await createBusinessOwner("owner-a@example.com", "Business A");
    const { business: businessB } = await createBusinessOwner("owner-b@example.com", "Business B");

    await businessAccessRepository.create({ userId: userA._id, businessId: businessB._id });
    await expect(
      businessAccessRepository.create({ userId: userA._id, businessId: businessB._id }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("provisions a TTL index on BusinessLinkVerification.otpExpiresAt", async () => {
    const indexes = await indexesFor(BusinessLinkVerificationModel);
    expect(
      indexes.some((index) => index.key["otpExpiresAt"] === 1 && index.expireAfterSeconds === 0),
    ).toBe(true);
  });

  it("requestLinkVerification emails an OTP to the target account without creating a link yet", async () => {
    const { user: userA } = await createBusinessOwner("owner-a@example.com", "Business A");
    const { user: userB, business: businessB } = await createBusinessOwner(
      "owner-b@example.com",
      "Business B",
    );

    const result = await businessService.requestLinkVerification(
      String(userA._id),
      "Owner-B@Example.com",
    );

    expect(result.verificationId).toEqual(expect.any(String));
    expect(emailProvider.lastTo).toBe("owner-b@example.com");
    expect(emailProvider.lastCode).toMatch(/^\d{4}$/);
    expect(await BusinessAccessModel.countDocuments()).toBe(0);

    const stored = await BusinessLinkVerificationModel.findById(result.verificationId)
      .select("+otpHash")
      .orFail();
    expect(stored.otpHash).not.toBe(emailProvider.lastCode);
    expect(stored.requesterUserId.equals(userA._id)).toBe(true);
    expect(stored.targetUserId.equals(userB._id)).toBe(true);
    expect(stored.targetBusinessId.equals(businessB._id)).toBe(true);
  });

  it("rejects a self-link verification request", async () => {
    const { user: userA } = await createBusinessOwner("owner-a@example.com", "Business A");

    await expect(
      businessService.requestLinkVerification(String(userA._id), "owner-a@example.com"),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(emailProvider.sentCount).toBe(0);
  });

  it("safely rejects verification requests for a nonexistent or non-Business-Owner email with a stable, non-enumerating error", async () => {
    const { user: userA } = await createBusinessOwner("owner-a@example.com", "Business A");
    await userRepository.create({
      normalizedEmail: "customer@example.com",
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });

    const missingError = await businessService
      .requestLinkVerification(String(userA._id), "nobody@example.com")
      .catch((error: unknown) => error);
    const customerError = await businessService
      .requestLinkVerification(String(userA._id), "customer@example.com")
      .catch((error: unknown) => error);

    expect(missingError).toBeInstanceOf(BusinessError);
    expect(customerError).toBeInstanceOf(BusinessError);
    expect((missingError as BusinessError).statusCode).toBe(
      (customerError as BusinessError).statusCode,
    );
    expect((missingError as BusinessError).message).toBe((customerError as BusinessError).message);
    expect(emailProvider.sentCount).toBe(0);
  });

  it("rejects requesting verification for a business that is already linked", async () => {
    const { user: userA } = await createBusinessOwner("owner-a@example.com", "Business A");
    await createBusinessOwner("owner-b@example.com", "Business B");
    await linkBusinessByEmail(String(userA._id), "owner-b@example.com");

    await expect(
      businessService.requestLinkVerification(String(userA._id), "owner-b@example.com"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("verifies with the correct OTP: creates exactly one BusinessAccess, keeps ownership, consumes the challenge", async () => {
    const { user: userA } = await createBusinessOwner("owner-a@example.com", "Business A");
    const { user: userB, business: businessB } = await createBusinessOwner(
      "owner-b@example.com",
      "Business B",
    );

    const linked = await linkBusinessByEmail(String(userA._id), "owner-b@example.com");

    expect(linked.id).toBe(String(businessB._id));
    expect(await BusinessModel.countDocuments()).toBe(2);
    const reloadedBusinessB = await BusinessModel.findById(businessB._id).orFail();
    expect(reloadedBusinessB.ownerUserId.equals(userB._id)).toBe(true);
    expect(await BusinessAccessModel.countDocuments()).toBe(1);

    const verification = await BusinessLinkVerificationModel.findOne({
      requesterUserId: userA._id,
    }).orFail();
    expect(verification.consumedAt).toBeInstanceOf(Date);
  });

  it("rejects an incorrect OTP, incrementing attempts, and never creates a link", async () => {
    const { user: userA } = await createBusinessOwner("owner-a@example.com", "Business A");
    await createBusinessOwner("owner-b@example.com", "Business B");

    const { verificationId } = await businessService.requestLinkVerification(
      String(userA._id),
      "owner-b@example.com",
    );

    await expect(
      businessService.verifyLinkVerification(String(userA._id), verificationId, "0000"),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await BusinessAccessModel.countDocuments()).toBe(0);

    const stored = await BusinessLinkVerificationModel.findById(verificationId).orFail();
    expect(stored.attempts).toBe(1);
  });

  it("locks out verification after too many wrong attempts", async () => {
    const { user: userA } = await createBusinessOwner("owner-a@example.com", "Business A");
    await createBusinessOwner("owner-b@example.com", "Business B");

    const { verificationId } = await businessService.requestLinkVerification(
      String(userA._id),
      "owner-b@example.com",
    );

    await BusinessLinkVerificationModel.updateOne(
      { _id: verificationId },
      { $set: { attempts: 5 } },
    );

    await expect(
      businessService.verifyLinkVerification(String(userA._id), verificationId, "1234"),
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it("rejects an expired OTP", async () => {
    const { user: userA } = await createBusinessOwner("owner-a@example.com", "Business A");
    await createBusinessOwner("owner-b@example.com", "Business B");

    const { verificationId } = await businessService.requestLinkVerification(
      String(userA._id),
      "owner-b@example.com",
    );
    await BusinessLinkVerificationModel.updateOne(
      { _id: verificationId },
      { $set: { otpExpiresAt: new Date(Date.now() - 1_000) } },
    );

    await expect(
      businessService.verifyLinkVerification(
        String(userA._id),
        verificationId,
        emailProvider.lastCode,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects replaying an already-consumed verification code", async () => {
    const { user: userA } = await createBusinessOwner("owner-a@example.com", "Business A");
    await createBusinessOwner("owner-b@example.com", "Business B");

    const { verificationId } = await businessService.requestLinkVerification(
      String(userA._id),
      "owner-b@example.com",
    );
    await businessService.verifyLinkVerification(
      String(userA._id),
      verificationId,
      emailProvider.lastCode,
    );

    await expect(
      businessService.verifyLinkVerification(
        String(userA._id),
        verificationId,
        emailProvider.lastCode,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await BusinessAccessModel.countDocuments()).toBe(1);
  });

  it("resend issues a new OTP that supersedes the old one and honors the cooldown", async () => {
    const { user: userA } = await createBusinessOwner("owner-a@example.com", "Business A");
    await createBusinessOwner("owner-b@example.com", "Business B");

    const { verificationId } = await businessService.requestLinkVerification(
      String(userA._id),
      "owner-b@example.com",
    );
    const firstCode = emailProvider.lastCode;

    await expect(
      businessService.resendLinkVerification(String(userA._id), verificationId),
    ).rejects.toMatchObject({ statusCode: 429 });

    await BusinessLinkVerificationModel.updateOne(
      { _id: verificationId },
      { $set: { sentAt: new Date(Date.now() - 5 * 60 * 1000) } },
    );

    await businessService.resendLinkVerification(String(userA._id), verificationId);
    const secondCode = emailProvider.lastCode;
    expect(secondCode).not.toBe(firstCode);
    expect(emailProvider.lastTo).toBe("owner-b@example.com");

    await expect(
      businessService.verifyLinkVerification(String(userA._id), verificationId, firstCode),
    ).rejects.toMatchObject({ statusCode: 400 });

    const linked = await businessService.verifyLinkVerification(
      String(userA._id),
      verificationId,
      secondCode,
    );
    expect(linked).toBeTruthy();
    expect(await BusinessAccessModel.countDocuments()).toBe(1);
  });

  it("results in exactly one BusinessAccess when two concurrent verify requests race", async () => {
    const { user: userA } = await createBusinessOwner("owner-a@example.com", "Business A");
    await createBusinessOwner("owner-b@example.com", "Business B");

    const { verificationId } = await businessService.requestLinkVerification(
      String(userA._id),
      "owner-b@example.com",
    );
    const code = emailProvider.lastCode;

    const outcomes = await Promise.allSettled([
      businessService.verifyLinkVerification(String(userA._id), verificationId, code),
      businessService.verifyLinkVerification(String(userA._id), verificationId, code),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await BusinessAccessModel.countDocuments()).toBe(1);
  });

  it("derives primary/secondary per authenticated user from the relationship, not stored labels", async () => {
    const { user: userA, business: businessA } = await createBusinessOwner(
      "owner-a@example.com",
      "Business A",
    );
    const { user: userB, business: businessB } = await createBusinessOwner(
      "owner-b@example.com",
      "Business B",
    );
    await linkBusinessByEmail(String(userA._id), "owner-b@example.com");

    const profileForA = await businessService.getBusinessProfile(String(userA._id));
    expect(profileForA.primary?.id).toBe(String(businessA._id));
    expect(profileForA.secondary.map((business) => business.id)).toEqual([String(businessB._id)]);

    const profileForB = await businessService.getBusinessProfile(String(userB._id));
    expect(profileForB.primary?.id).toBe(String(businessB._id));
    expect(profileForB.secondary).toEqual([]);
  });

  it("enforces owner-only edit and owner-or-linked view, blocking unrelated users", async () => {
    const { user: userA } = await createBusinessOwner("owner-a@example.com", "Business A");
    const { user: userB, business: businessB } = await createBusinessOwner(
      "owner-b@example.com",
      "Business B",
    );
    const { user: userC } = await createBusinessOwner("owner-c@example.com", "Business C");
    await linkBusinessByEmail(String(userA._id), "owner-b@example.com");

    const ownerDetail = await businessService.getBusinessDetail(
      String(userB._id),
      String(businessB._id),
    );
    expect(ownerDetail.relationship).toBe("OWNER");

    const linkedDetail = await businessService.getBusinessDetail(
      String(userA._id),
      String(businessB._id),
    );
    expect(linkedDetail.relationship).toBe("LINKED");

    await expect(
      businessService.getBusinessDetail(String(userC._id), String(businessB._id)),
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(
      businessService.updateOwnedBusiness(String(userA._id), String(businessB._id), {
        name: "Hijacked Name",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await BusinessModel.findById(businessB._id).orFail()).name).toBe("Business B");

    const updated = await businessService.updateOwnedBusiness(
      String(userB._id),
      String(businessB._id),
      {
        name: "Business B Renamed",
        area: "New Area",
      },
    );
    expect(updated.name).toBe("Business B Renamed");
    expect(updated.address.area).toBe("New Area");
    expect(updated.status).toBe("PENDING");
  });

  it("unlinks only the relationship without deleting the Business or changing ownership", async () => {
    const { user: userA } = await createBusinessOwner("owner-a@example.com", "Business A");
    const { user: userB, business: businessB } = await createBusinessOwner(
      "owner-b@example.com",
      "Business B",
    );
    await linkBusinessByEmail(String(userA._id), "owner-b@example.com");

    await businessService.unlinkBusiness(String(userA._id), String(businessB._id));

    expect(await BusinessAccessModel.countDocuments()).toBe(0);
    expect(await BusinessModel.countDocuments({ _id: businessB._id })).toBe(1);
    const reloadedBusinessB = await BusinessModel.findById(businessB._id).orFail();
    expect(reloadedBusinessB.ownerUserId.equals(userB._id)).toBe(true);

    const profileForA = await businessService.getBusinessProfile(String(userA._id));
    expect(profileForA.secondary).toEqual([]);
  });

  it("rejects unlinking a relationship that does not exist", async () => {
    const { user: userA } = await createBusinessOwner("owner-a@example.com", "Business A");
    const { business: businessB } = await createBusinessOwner("owner-b@example.com", "Business B");

    await expect(
      businessService.unlinkBusiness(String(userA._id), String(businessB._id)),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  describe("Business.timezone (Phase 0)", () => {
    it("defaults a newly-created Business to Europe/Nicosia", async () => {
      const { business } = await createBusinessOwner("owner-a@example.com", "Business A");
      expect(business.timezone).toBe("Europe/Nicosia");

      const reloaded = await BusinessModel.findById(business._id).orFail();
      expect(reloaded.timezone).toBe("Europe/Nicosia");
    });

    it("a Business Owner can change their Business's timezone via the existing update path", async () => {
      const { user, business } = await createBusinessOwner("owner-a@example.com", "Business A");

      const updated = await businessService.updateOwnedBusiness(
        String(user._id),
        String(business._id),
        {
          timezone: "Europe/London",
        },
      );

      expect(updated.timezone).toBe("Europe/London");
      const reloaded = await BusinessModel.findById(business._id).orFail();
      expect(reloaded.timezone).toBe("Europe/London");
    });

    it("rejects an invalid IANA timezone at the model layer (defense in depth beyond Zod)", async () => {
      const { business } = await createBusinessOwner("owner-a@example.com", "Business A");

      await expect(
        BusinessModel.findByIdAndUpdate(
          business._id,
          { $set: { timezone: "Not/AZone" } },
          { runValidators: true },
        ).orFail(),
      ).rejects.toThrow();
    });

    it("legacy Business documents that predate the timezone field remain safe to read (no destructive migration required)", async () => {
      const { business } = await createBusinessOwner("owner-a@example.com", "Business A");

      // Simulate a pre-existing document from before this field existed: unset it directly at
      // the driver level, bypassing Mongoose entirely.
      await BusinessModel.collection.updateOne({ _id: business._id }, { $unset: { timezone: "" } });

      // Confirmed genuinely absent in storage (not just "falsy") via the raw driver, bypassing
      // Mongoose's own query hydration.
      const rawDocument = await BusinessModel.collection.findOne({ _id: business._id });
      expect(rawDocument).not.toHaveProperty("timezone");

      // No destructive backfill migration was run, yet every read path still resolves safely
      // to the platform default rather than surfacing `undefined` or throwing — whether via
      // Mongoose's own schema-default-on-hydrate behavior (observed in this Mongoose version)
      // or, for any path that bypasses hydration (e.g. .lean()/aggregation), the explicit
      // resolveBusinessTimezone() fallback in common/time/timezone.ts.
      const reloaded = await BusinessModel.findById(business._id).orFail();
      expect(reloaded.timezone).toBe("Europe/Nicosia");

      const detail = await businessService.getBusinessDetail(
        String(business.ownerUserId),
        String(business._id),
      );
      expect(detail.timezone).toBe("Europe/Nicosia");
    });
  });
});
