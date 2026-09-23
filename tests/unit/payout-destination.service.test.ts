import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BusinessDocument } from "../../src/modules/business/business.model.js";
import type { BusinessRepository } from "../../src/modules/business/business.repository.js";
import type { PayoutDestinationDocument } from "../../src/modules/payout-destination/payout-destination.model.js";
import type { PayoutDestinationRepository } from "../../src/modules/payout-destination/payout-destination.repository.js";
import type { PayoutDestinationStepUpRepository } from "../../src/modules/payout-destination/payout-destination-step-up.repository.js";
import type { UserDocument } from "../../src/modules/user/user.model.js";
import type { UserRepository } from "../../src/modules/user/user.repository.js";
import type { EmailOtpProvider } from "../../src/modules/verification/email-otp.provider.js";

const { encryptIban } = await import(
  "../../src/modules/payout-destination/payout-destination.crypto.js"
);
const { PayoutDestinationError } = await import(
  "../../src/modules/payout-destination/payout-destination.errors.js"
);
const { PayoutDestinationService } = await import(
  "../../src/modules/payout-destination/payout-destination.service.js"
);

// SYNTHETIC, valid-checksum test IBANs only — never anybody's real account.
const IBAN_CY = "CY17002001280000001200527600";
const IBAN_DE = "DE89370400440532013000";
const IBAN_GB = "GB33BUKB20201555555555";
const IBAN_INVALID = "CY17002001280000001200527601"; // one digit off => mod-97 fails

const OWNER_ID = new Types.ObjectId();
const OTHER_OWNER_ID = new Types.ObjectId();
const BUSINESS_ID = new Types.ObjectId();
const ADMIN_ID = new Types.ObjectId();

const buildBusiness = (overrides: Partial<BusinessDocument> = {}): BusinessDocument =>
  ({
    _id: BUSINESS_ID,
    ownerUserId: OWNER_ID,
    name: "Ledra Barbers",
    ...overrides,
  }) as BusinessDocument;

const buildUser = (overrides: Partial<UserDocument> = {}): UserDocument =>
  ({
    _id: OWNER_ID,
    normalizedEmail: "owner@example.com",
    role: "BUSINESS_OWNER",
    status: "ACTIVE",
    authProviders: ["PASSWORD"],
    passwordHash: "stored-hash",
    ...overrides,
  }) as UserDocument;

/** An in-memory stand-in for the one-row-per-Business collection, including the schema's
 * `select: false` behaviour: the masked read does NOT return the secret fields. */
const buildDestinationStore = () => {
  let row: Record<string, unknown> | null = null;

  const withoutSecrets = (): PayoutDestinationDocument | null => {
    if (!row) return null;
    const { ibanCiphertext, ibanIv, ibanAuthTag, ...rest } = row;
    void ibanCiphertext;
    void ibanIv;
    void ibanAuthTag;
    return rest as unknown as PayoutDestinationDocument;
  };

  const repository = {
    findByBusinessId: vi.fn(async () => withoutSecrets()),
    findByBusinessIdWithSecret: vi.fn(async () =>
      row ? ({ ...row } as unknown as PayoutDestinationDocument) : null,
    ),
    upsert: vi.fn(async (businessId: Types.ObjectId, input: Record<string, unknown>, entry) => {
      const history = [...((row?.["history"] as unknown[]) ?? []), entry];
      row = {
        _id: row?.["_id"] ?? new Types.ObjectId(),
        businessId,
        ...input,
        history,
        createdAt: row?.["createdAt"] ?? new Date(),
        updatedAt: new Date(),
      };
      return { ...row } as unknown as PayoutDestinationDocument;
    }),
    appendHistory: vi.fn(async (_businessId, entry) => {
      if (row) row["history"] = [...((row["history"] as unknown[]) ?? []), entry];
    }),
  };

  return {
    repository: repository as unknown as PayoutDestinationRepository,
    raw: () => row,
    count: () => (row ? 1 : 0),
  };
};

describe("PayoutDestinationService", () => {
  let store: ReturnType<typeof buildDestinationStore>;
  let businessRepository: BusinessRepository;
  let userRepository: UserRepository;
  let stepUpRepository: PayoutDestinationStepUpRepository;
  let emailProvider: EmailOtpProvider & {
    sendOtp: ReturnType<typeof vi.fn>;
    sendNotice: ReturnType<typeof vi.fn>;
  };
  let passwordHasher: { hash: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> };
  let stepUpRow: Record<string, unknown> | null;
  let service: InstanceType<typeof PayoutDestinationService>;

  const buildService = (user: UserDocument = buildUser()) => {
    businessRepository = {
      findById: vi.fn(async (id: string) =>
        String(id) === String(BUSINESS_ID) ? buildBusiness() : null,
      ),
    } as unknown as BusinessRepository;

    userRepository = {
      findByIdWithPassword: vi.fn(async () => user),
    } as unknown as UserRepository;

    return new PayoutDestinationService(
      businessRepository,
      userRepository,
      store.repository,
      stepUpRepository,
      passwordHasher as never,
      emailProvider,
    );
  };

  beforeEach(() => {
    store = buildDestinationStore();
    stepUpRow = null;
    passwordHasher = {
      hash: vi.fn(async (value: string) => `hashed:${value}`),
      // Only "correct-password" verifies — everything else (including undefined) fails.
      verify: vi.fn(
        async (_hash: string | undefined, password: string) =>
          Boolean(_hash) && password === "correct-password",
      ),
    };
    emailProvider = {
      sendOtp: vi.fn(async () => undefined),
      sendNotice: vi.fn(async () => undefined),
    } as never;

    stepUpRepository = {
      findActive: vi.fn(async () => stepUpRow),
      upsertOtpChallenge: vi.fn(async (userId, businessId, purpose, input) => {
        stepUpRow = {
          _id: new Types.ObjectId(),
          userId,
          businessId,
          purpose,
          attempts: 0,
          ...input,
        };
      }),
      incrementAttempts: vi.fn(async () => {
        if (stepUpRow) stepUpRow["attempts"] = (stepUpRow["attempts"] as number) + 1;
      }),
      promoteToAuthorization: vi.fn(async (_id, input) => {
        if (!stepUpRow?.["otpHash"]) return null;
        delete stepUpRow["otpHash"];
        delete stepUpRow["otpExpiresAt"];
        stepUpRow = { ...stepUpRow, ...input };
        return stepUpRow;
      }),
      consumeAuthorization: vi.fn(async (input: { authorizationTokenHash: string }) => {
        if (stepUpRow?.["authorizationTokenHash"] !== input.authorizationTokenHash) return null;
        const claimed = stepUpRow;
        stepUpRow = null; // single use
        return claimed;
      }),
    } as unknown as PayoutDestinationStepUpRepository;

    service = buildService();
  });

  const validBody = (overrides: Record<string, unknown> = {}) =>
    ({
      accountHolderName: "Maria Georgiou",
      iban: IBAN_CY,
      bankName: "Bank of Cyprus",
      stepUp: { currentPassword: "correct-password" },
      ...overrides,
    }) as never;

  // --- Owner: create / update ----------------------------------------------------------------

  it("lets a BUSINESS_OWNER create a destination for their own Business", async () => {
    const view = await service.upsertForOwner(String(OWNER_ID), String(BUSINESS_ID), validBody());

    expect(view).toMatchObject({
      configured: true,
      accountHolderName: "Maria Georgiou",
      ibanMasked: "CY••••••••7600",
      ibanLast4: "7600",
      ibanCountry: "CY",
      bankName: "Bank of Cyprus",
    });
    expect(store.raw()?.["history"]).toMatchObject([{ action: "CREATED", newLast4: "7600" }]);
  });

  it("normalizes the IBAN (whitespace/case) before validating, deriving and encrypting", async () => {
    await service.upsertForOwner(
      String(OWNER_ID),
      String(BUSINESS_ID),
      validBody({ iban: "  cy17 0020 0128 0000 0012 0052 7600  " }),
    );

    expect(store.raw()?.["ibanLast4"]).toBe("7600");
    expect(store.raw()?.["ibanCountry"]).toBe("CY");
    // Neither the original formatting nor the plaintext is anywhere in the stored row.
    const serialized = JSON.stringify(store.raw());
    expect(serialized).not.toContain("0020 0128");
    expect(serialized).not.toContain(IBAN_CY);
  });

  it("replaces (does not duplicate) on a second write, recording previousLast4 -> newLast4", async () => {
    await service.upsertForOwner(String(OWNER_ID), String(BUSINESS_ID), validBody());
    await service.upsertForOwner(
      String(OWNER_ID),
      String(BUSINESS_ID),
      validBody({ iban: IBAN_DE, accountHolderName: "Maria G." }),
    );

    expect(store.count()).toBe(1);
    expect(store.raw()?.["ibanLast4"]).toBe("3000");
    expect(store.raw()?.["history"]).toMatchObject([
      { action: "CREATED", newLast4: "7600" },
      { action: "UPDATED", previousLast4: "7600", newLast4: "3000" },
    ]);
  });

  it("rejects an invalid IBAN (mod-97 checksum) without writing anything", async () => {
    await expect(
      service.upsertForOwner(
        String(OWNER_ID),
        String(BUSINESS_ID),
        validBody({
          iban: IBAN_INVALID,
        }),
      ),
    ).rejects.toBeInstanceOf(PayoutDestinationError);

    expect(store.count()).toBe(0);
    expect(emailProvider.sendNotice).not.toHaveBeenCalled();
  });

  // --- Owner: masked read --------------------------------------------------------------------

  it("returns { configured: false } when nothing is stored", async () => {
    await expect(service.getForOwner(String(OWNER_ID), String(BUSINESS_ID))).resolves.toEqual({
      configured: false,
    });
  });

  it("masked GET never includes the full IBAN or any encryption metadata", async () => {
    await service.upsertForOwner(String(OWNER_ID), String(BUSINESS_ID), validBody());

    const view = await service.getForOwner(String(OWNER_ID), String(BUSINESS_ID));
    const serialized = JSON.stringify(view);

    expect(serialized).not.toContain(IBAN_CY);
    expect(serialized).not.toContain("ibanCiphertext");
    expect(serialized).not.toContain("ibanIv");
    expect(serialized).not.toContain("ibanAuthTag");
    expect(serialized).not.toContain("ibanKeyVersion");
    expect(Object.keys(view).sort()).toEqual([
      "accountHolderName",
      "bankName",
      "configured",
      "ibanCountry",
      "ibanLast4",
      "ibanMasked",
      "updatedAt",
    ]);
  });

  // --- Ownership ------------------------------------------------------------------------------

  it("denies an unrelated BUSINESS_OWNER (404, same as FinanceService's convention)", async () => {
    await expect(
      service.getForOwner(String(OTHER_OWNER_ID), String(BUSINESS_ID)),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      service.upsertForOwner(String(OTHER_OWNER_ID), String(BUSINESS_ID), validBody()),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(store.count()).toBe(0);
  });

  it("answers 404 for an unknown or malformed businessId", async () => {
    await expect(
      service.getForOwner(String(OWNER_ID), String(new Types.ObjectId())),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.getForOwner(String(OWNER_ID), "not-an-id")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  // --- Step-up: password accounts --------------------------------------------------------------

  it("rejects a wrong current password, leaving the destination unchanged with no history or notification", async () => {
    await service.upsertForOwner(String(OWNER_ID), String(BUSINESS_ID), validBody());
    const before = JSON.stringify(store.raw());
    emailProvider.sendNotice.mockClear();

    await expect(
      service.upsertForOwner(
        String(OWNER_ID),
        String(BUSINESS_ID),
        validBody({ iban: IBAN_GB, stepUp: { currentPassword: "wrong-password" } }),
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/current password/i),
    });

    expect(JSON.stringify(store.raw())).toBe(before);
    expect((store.raw() as Record<string, unknown>)["history"] as unknown[]).toHaveLength(1);
    expect(emailProvider.sendNotice).not.toHaveBeenCalled();
  });

  it("rejects an absent current password for a password account", async () => {
    await expect(
      service.upsertForOwner(String(OWNER_ID), String(BUSINESS_ID), validBody({ stepUp: {} })),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(store.count()).toBe(0);
  });

  it("ignores an OTP proof sent by a password account (server decides the factor)", async () => {
    await expect(
      service.upsertForOwner(
        String(OWNER_ID),
        String(BUSINESS_ID),
        validBody({ stepUp: { otpAuthorizationToken: "anything" } }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(store.count()).toBe(0);
  });

  it("sends the owner a notification containing only safe fields on success", async () => {
    await service.upsertForOwner(String(OWNER_ID), String(BUSINESS_ID), validBody());

    expect(emailProvider.sendNotice).toHaveBeenCalledTimes(1);
    const notice = emailProvider.sendNotice.mock.calls[0]?.[0] as {
      to: string;
      subject: string;
      text: string;
    };
    expect(notice.to).toBe("owner@example.com");
    expect(notice.text).toContain("Ledra Barbers");
    expect(notice.text).toContain("CY••••••••7600");
    expect(notice.text).not.toContain(IBAN_CY);
    expect(notice.text).not.toContain("correct-password");
  });

  it("does not fail the write when the notification email fails (fire-and-forget convention)", async () => {
    emailProvider.sendNotice.mockRejectedValueOnce(new Error("smtp down"));

    await expect(
      service.upsertForOwner(String(OWNER_ID), String(BUSINESS_ID), validBody()),
    ).resolves.toMatchObject({ configured: true });
    expect(store.count()).toBe(1);
  });

  // --- Step-up: OAuth-only accounts -------------------------------------------------------------

  describe("OAuth-only owner (hasPassword === false)", () => {
    const oauthUser = () =>
      buildUser({ authProviders: ["GOOGLE"], passwordHash: undefined } as never);

    beforeEach(() => {
      service = buildService(oauthUser());
    });

    const completeStepUp = async () => {
      await service.requestStepUpOtp(String(OWNER_ID), String(BUSINESS_ID));
      const code = (emailProvider.sendOtp.mock.calls.at(-1) as [{ code: string }])[0].code;
      return service.verifyStepUpOtp(String(OWNER_ID), String(BUSINESS_ID), code);
    };

    it("requires an OTP proof — a password is not accepted", async () => {
      await expect(
        service.upsertForOwner(
          String(OWNER_ID),
          String(BUSINESS_ID),
          validBody({ stepUp: { currentPassword: "correct-password" } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(store.count()).toBe(0);
    });

    it("sends a PAYOUT_DESTINATION_CHANGE OTP and accepts the resulting proof", async () => {
      const { otpAuthorizationToken } = await completeStepUp();

      expect(emailProvider.sendOtp).toHaveBeenCalledWith(
        expect.objectContaining({ to: "owner@example.com", purpose: "PAYOUT_DESTINATION_CHANGE" }),
      );

      await expect(
        service.upsertForOwner(
          String(OWNER_ID),
          String(BUSINESS_ID),
          validBody({ stepUp: { otpAuthorizationToken } }),
        ),
      ).resolves.toMatchObject({ configured: true });
    });

    it("rejects a wrong OTP and counts the attempt", async () => {
      await service.requestStepUpOtp(String(OWNER_ID), String(BUSINESS_ID));

      await expect(
        service.verifyStepUpOtp(String(OWNER_ID), String(BUSINESS_ID), "0000000"),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(stepUpRepository.incrementAttempts).toHaveBeenCalled();
    });

    it("rejects an expired OTP", async () => {
      await service.requestStepUpOtp(String(OWNER_ID), String(BUSINESS_ID));
      const code = (emailProvider.sendOtp.mock.calls.at(-1) as [{ code: string }])[0].code;
      if (stepUpRow) stepUpRow["otpExpiresAt"] = new Date(Date.now() - 1000);

      await expect(
        service.verifyStepUpOtp(String(OWNER_ID), String(BUSINESS_ID), code),
      ).rejects.toMatchObject({ message: expect.stringMatching(/expired/i) });
    });

    it("makes the authorization proof SINGLE USE — a replay is rejected", async () => {
      const { otpAuthorizationToken } = await completeStepUp();

      await service.upsertForOwner(
        String(OWNER_ID),
        String(BUSINESS_ID),
        validBody({ stepUp: { otpAuthorizationToken } }),
      );
      const afterFirst = JSON.stringify(store.raw());

      await expect(
        service.upsertForOwner(
          String(OWNER_ID),
          String(BUSINESS_ID),
          validBody({ iban: IBAN_GB, stepUp: { otpAuthorizationToken } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(JSON.stringify(store.raw())).toBe(afterFirst);
    });

    it("rejects an expired authorization proof", async () => {
      const { otpAuthorizationToken } = await completeStepUp();
      if (stepUpRow) stepUpRow["authorizationExpiresAt"] = new Date(Date.now() - 1000);

      await expect(
        service.upsertForOwner(
          String(OWNER_ID),
          String(BUSINESS_ID),
          validBody({ stepUp: { otpAuthorizationToken } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(store.count()).toBe(0);
    });

    it("rejects a fabricated/unknown proof", async () => {
      await completeStepUp();

      await expect(
        service.upsertForOwner(
          String(OWNER_ID),
          String(BUSINESS_ID),
          validBody({ stepUp: { otpAuthorizationToken: "not-the-real-token" } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(store.count()).toBe(0);
    });

    it("cannot be satisfied by an OTP hashed for a DIFFERENT purpose (purpose isolation)", async () => {
      const { createHash } = await import("node:crypto");
      const { env } = await import("../../src/config/env.js");

      await service.requestStepUpOtp(String(OWNER_ID), String(BUSINESS_ID));
      const code = (emailProvider.sendOtp.mock.calls.at(-1) as [{ code: string }])[0].code;
      const storedHash = stepUpRow?.["otpHash"] as string;

      const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
      // The salt scheme AuthService.hashContactChangeOtp uses for EMAIL_CHANGE.
      const emailChangeHash = sha256(
        `${OWNER_ID}:EMAIL_CHANGE:owner@example.com:${code}:${env.OTP_HASH_SECRET}`,
      );
      // ...and what this module produces for the same code.
      const payoutHash = sha256(
        `${OWNER_ID}:PAYOUT_DESTINATION_CHANGE:${BUSINESS_ID}:${code}:${env.OTP_HASH_SECRET}`,
      );

      expect(storedHash).toBe(payoutHash);
      expect(storedHash).not.toBe(emailChangeHash);
    });
  });

  // --- Super Admin --------------------------------------------------------------------------

  it("gives Super Admin the SAME masked view as the Owner, with no ownership check", async () => {
    await service.upsertForOwner(String(OWNER_ID), String(BUSINESS_ID), validBody());

    const owner = await service.getForOwner(String(OWNER_ID), String(BUSINESS_ID));
    const admin = await service.getForSuperAdmin(String(BUSINESS_ID));

    expect(admin).toEqual(owner);
    expect(JSON.stringify(admin)).not.toContain(IBAN_CY);
  });

  it("reveals the full IBAN and audits it as IBAN_REVEALED without storing the IBAN", async () => {
    await service.upsertForOwner(String(OWNER_ID), String(BUSINESS_ID), validBody());

    const revealed = await service.revealIbanForSuperAdmin(String(ADMIN_ID), String(BUSINESS_ID));

    expect(revealed.iban).toBe(IBAN_CY);
    expect(revealed.accountHolderName).toBe("Maria Georgiou");
    expect(revealed.bankName).toBe("Bank of Cyprus");
    expect(revealed.revealedAt).toBeInstanceOf(Date);

    const history = store.raw()?.["history"] as Array<Record<string, unknown>>;
    const audit = history.at(-1);
    expect(audit?.["action"]).toBe("IBAN_REVEALED");
    expect(String(audit?.["actorUserId"])).toBe(String(ADMIN_ID));
    expect(audit?.["changedAt"]).toBeInstanceOf(Date);
    expect(JSON.stringify(history)).not.toContain(IBAN_CY);
  });

  it("rejects a reveal when nothing is configured", async () => {
    await expect(
      service.revealIbanForSuperAdmin(String(ADMIN_ID), String(BUSINESS_ID)),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("fails closed on a corrupted ciphertext at reveal time, writing no audit entry", async () => {
    await service.upsertForOwner(String(OWNER_ID), String(BUSINESS_ID), validBody());
    const row = store.raw();
    if (row) {
      const current = row["ibanCiphertext"] as string;
      row["ibanCiphertext"] = `${current.slice(0, -1)}${current.slice(-1) === "0" ? "1" : "0"}`;
    }

    await expect(
      service.revealIbanForSuperAdmin(String(ADMIN_ID), String(BUSINESS_ID)),
    ).rejects.toMatchObject({ statusCode: 500 });

    const history = store.raw()?.["history"] as Array<Record<string, unknown>>;
    expect(history.some((entry) => entry["action"] === "IBAN_REVEALED")).toBe(false);
  });

  it("fails closed when the ciphertext belongs to a DIFFERENT Business (AAD binding)", async () => {
    await service.upsertForOwner(String(OWNER_ID), String(BUSINESS_ID), validBody());
    const foreign = encryptIban(IBAN_GB, new Types.ObjectId());
    const row = store.raw();
    if (row) {
      row["ibanCiphertext"] = foreign.ciphertext;
      row["ibanIv"] = foreign.iv;
      row["ibanAuthTag"] = foreign.authTag;
    }

    await expect(
      service.revealIbanForSuperAdmin(String(ADMIN_ID), String(BUSINESS_ID)),
    ).rejects.toMatchObject({ statusCode: 500 });
  });

  it("fails closed on an unknown stored key version rather than reporting 'not configured'", async () => {
    await service.upsertForOwner(String(OWNER_ID), String(BUSINESS_ID), validBody());
    const row = store.raw();
    if (row) row["ibanKeyVersion"] = 42;

    await expect(
      service.revealIbanForSuperAdmin(String(ADMIN_ID), String(BUSINESS_ID)),
    ).rejects.toMatchObject({ statusCode: 500 });
  });
});
