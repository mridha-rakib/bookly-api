import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PasswordHasher } from "../../src/modules/auth/password-hasher.js";
import type { LinkedAccountDocument } from "../../src/modules/linked-account/linked-account.model.js";
import type { LinkedAccountRepository } from "../../src/modules/linked-account/linked-account.repository.js";
import type { UserDocument } from "../../src/modules/user/user.model.js";
import type { UserRepository } from "../../src/modules/user/user.repository.js";

const mockEnv = {
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_ACCOUNT_LINK_REDIRECT_URI: "http://localhost:3000/api/v1/auth/oauth/google/callback",
};

vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));

const isGoogleAccountLinkConfigured = vi.fn(() => true);
const buildGoogleAccountLinkAuthUrl = vi.fn(
  (_state: string) => "https://accounts.google.com/o/oauth2/v2/auth?mock=1",
);
const verifyGoogleAccountLinkCallback = vi.fn();

vi.mock("../../src/modules/linked-account/google-oauth.client.js", () => ({
  isGoogleAccountLinkConfigured,
  buildGoogleAccountLinkAuthUrl,
  verifyGoogleAccountLinkCallback,
}));

const { LinkedAccountService } = await import(
  "../../src/modules/linked-account/linked-account.service.js"
);
const { signGoogleLinkState, verifyGoogleLinkState } = await import(
  "../../src/modules/linked-account/linked-account.state.js"
);

const buildUser = (overrides: Partial<UserDocument> = {}): UserDocument =>
  ({
    _id: new Types.ObjectId(),
    normalizedEmail: "customer@example.com",
    passwordHash: "argon2-hash",
    role: "CUSTOMER",
    status: "ACTIVE",
    ...overrides,
  }) as UserDocument;

const buildLinkedAccount = (
  overrides: Partial<LinkedAccountDocument> = {},
): LinkedAccountDocument =>
  ({
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    provider: "GOOGLE",
    providerAccountId: "google-sub-1",
    email: "person@gmail.com",
    emailVerified: true,
    displayName: "Person Example",
    linkedAt: new Date("2026-09-01T10:00:00.000Z"),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as LinkedAccountDocument;

const makeService = (parts: {
  repo?: Partial<LinkedAccountRepository>;
  hasher?: Partial<PasswordHasher>;
  users?: Partial<UserRepository>;
}) => {
  const repo = {
    findByProviderAccount: vi.fn().mockResolvedValue(null),
    findByUserAndProvider: vi.fn().mockResolvedValue(null),
    findByUserId: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(buildLinkedAccount()),
    deleteByUserAndProvider: vi.fn().mockResolvedValue(true),
    deleteAllForUser: vi.fn().mockResolvedValue(undefined),
    ...parts.repo,
  } as unknown as LinkedAccountRepository;
  const hasher = {
    hash: vi.fn(),
    verify: vi.fn().mockResolvedValue(true),
    ...parts.hasher,
  } as unknown as PasswordHasher;
  const users = {
    findById: vi.fn(),
    findByIdWithPassword: vi.fn(),
    ...parts.users,
  } as unknown as UserRepository;

  return { service: new LinkedAccountService(repo, hasher, users), repo, hasher, users };
};

describe("LinkedAccountService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isGoogleAccountLinkConfigured.mockReturnValue(true);
    buildGoogleAccountLinkAuthUrl.mockReturnValue(
      "https://accounts.google.com/o/oauth2/v2/auth?mock=1",
    );
  });

  describe("buildGoogleAuthorizeUrl", () => {
    it("throws LINKED_ACCOUNT_NOT_CONFIGURED (503) when linking is not configured", async () => {
      isGoogleAccountLinkConfigured.mockReturnValue(false);
      const { service } = makeService({});

      await expect(service.buildGoogleAuthorizeUrl("user-1")).rejects.toMatchObject({
        statusCode: 503,
      });
    });

    it("signs a state bound to the caller's userId and returns Google's consent URL", async () => {
      const { service } = makeService({});
      const userId = String(new Types.ObjectId());

      const url = await service.buildGoogleAuthorizeUrl(userId);

      expect(url).toBe("https://accounts.google.com/o/oauth2/v2/auth?mock=1");
      const state = buildGoogleAccountLinkAuthUrl.mock.calls[0]?.[0] as string;
      await expect(verifyGoogleLinkState(state)).resolves.toEqual({ userId });
    });
  });

  describe("linkGoogleFromCallback", () => {
    const validIdentity = {
      providerAccountId: "google-sub-1",
      email: "Person@Gmail.com",
      emailVerified: true,
      displayName: "Person Example",
    };

    it("rejects an invalid state before any Google call or write", async () => {
      const { service, repo } = makeService({});

      await expect(service.linkGoogleFromCallback("code", "forged-state")).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(verifyGoogleAccountLinkCallback).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });

    it("rejects a state whose user is no longer a linkable customer", async () => {
      const { service, users } = makeService({
        users: { findById: vi.fn().mockResolvedValue(buildUser({ status: "DELETED" })) },
      });
      const state = await signGoogleLinkState({ userId: String(new Types.ObjectId()) });

      await expect(service.linkGoogleFromCallback("code", state)).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(users.findById).toHaveBeenCalledTimes(1);
    });

    it("links the verified identity to the state's user — normalising email, never looked up by email", async () => {
      const user = buildUser();
      const { service, repo } = makeService({
        users: { findById: vi.fn().mockResolvedValue(user) },
      });
      verifyGoogleAccountLinkCallback.mockResolvedValue(validIdentity);
      const state = await signGoogleLinkState({ userId: String(user._id) });

      await service.linkGoogleFromCallback("auth-code", state);

      expect(repo.create).toHaveBeenCalledTimes(1);
      const createArg = (repo.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(String(createArg.userId)).toBe(String(user._id));
      expect(createArg.provider).toBe("GOOGLE");
      expect(createArg.providerAccountId).toBe("google-sub-1");
      expect(createArg.email).toBe("person@gmail.com");
      expect(createArg.emailVerified).toBe(true);
      expect(createArg.displayName).toBe("Person Example");
      expect(createArg.linkedAt).toBeInstanceOf(Date);
    });

    it("rejects when the Google account already belongs to another user (ALREADY_LINKED_ELSEWHERE)", async () => {
      const user = buildUser();
      const { service, repo } = makeService({
        users: { findById: vi.fn().mockResolvedValue(user) },
        repo: {
          findByProviderAccount: vi
            .fn()
            .mockResolvedValue(buildLinkedAccount({ userId: new Types.ObjectId() })),
        },
      });
      verifyGoogleAccountLinkCallback.mockResolvedValue(validIdentity);
      const state = await signGoogleLinkState({ userId: String(user._id) });

      await expect(service.linkGoogleFromCallback("code", state)).rejects.toMatchObject({
        statusCode: 409,
        details: [{ code: "LINKED_ACCOUNT_ALREADY_LINKED_ELSEWHERE" }],
      });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it("is idempotent when the same Google account is re-linked by the same user", async () => {
      const user = buildUser();
      const { service, repo } = makeService({
        users: { findById: vi.fn().mockResolvedValue(user) },
        repo: {
          findByProviderAccount: vi
            .fn()
            .mockResolvedValue(buildLinkedAccount({ userId: user._id })),
        },
      });
      verifyGoogleAccountLinkCallback.mockResolvedValue(validIdentity);
      const state = await signGoogleLinkState({ userId: String(user._id) });

      await expect(service.linkGoogleFromCallback("code", state)).resolves.toBeUndefined();
      expect(repo.create).not.toHaveBeenCalled();
    });

    it("rejects when the user already has a different Google account linked", async () => {
      const user = buildUser();
      const { service } = makeService({
        users: { findById: vi.fn().mockResolvedValue(user) },
        repo: {
          findByProviderAccount: vi.fn().mockResolvedValue(null),
          findByUserAndProvider: vi
            .fn()
            .mockResolvedValue(
              buildLinkedAccount({ userId: user._id, providerAccountId: "other" }),
            ),
        },
      });
      verifyGoogleAccountLinkCallback.mockResolvedValue(validIdentity);
      const state = await signGoogleLinkState({ userId: String(user._id) });

      await expect(service.linkGoogleFromCallback("code", state)).rejects.toMatchObject({
        statusCode: 409,
        details: [{ code: "LINKED_ACCOUNT_PROVIDER_ALREADY_LINKED" }],
      });
    });

    it("maps a duplicate-key race on create to a stable 409", async () => {
      const user = buildUser();
      const duplicateKeyError = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
      const { service } = makeService({
        users: { findById: vi.fn().mockResolvedValue(user) },
        repo: {
          findByProviderAccount: vi
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(buildLinkedAccount({ userId: user._id })),
          findByUserAndProvider: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockRejectedValue(duplicateKeyError),
        },
      });
      verifyGoogleAccountLinkCallback.mockResolvedValue(validIdentity);
      const state = await signGoogleLinkState({ userId: String(user._id) });

      await expect(service.linkGoogleFromCallback("code", state)).rejects.toMatchObject({
        statusCode: 409,
      });
    });
  });

  describe("unlinkGoogle", () => {
    it("throws SESSION_EXPIRED (401) when the user no longer exists", async () => {
      const { service } = makeService({
        users: { findByIdWithPassword: vi.fn().mockResolvedValue(null) },
      });

      await expect(service.unlinkGoogle("user-1", { currentPassword: "pw" })).rejects.toMatchObject(
        { statusCode: 401 },
      );
    });

    it("rejects a wrong current password with INVALID_CURRENT_PASSWORD (400)", async () => {
      const { service } = makeService({
        users: { findByIdWithPassword: vi.fn().mockResolvedValue(buildUser()) },
        hasher: { verify: vi.fn().mockResolvedValue(false) },
      });

      await expect(
        service.unlinkGoogle("user-1", { currentPassword: "wrong" }),
      ).rejects.toMatchObject({ statusCode: 400, details: [{ code: "INVALID_CURRENT_PASSWORD" }] });
    });

    it("throws LINKED_ACCOUNT_NOT_FOUND (404) when there is no Google link", async () => {
      const { service } = makeService({
        users: { findByIdWithPassword: vi.fn().mockResolvedValue(buildUser()) },
        repo: { findByUserAndProvider: vi.fn().mockResolvedValue(null) },
      });

      await expect(service.unlinkGoogle("user-1", { currentPassword: "pw" })).rejects.toMatchObject(
        { statusCode: 404 },
      );
    });

    it("unlinks successfully when the account still has a usable password", async () => {
      const user = buildUser();
      const { service, repo } = makeService({
        users: { findByIdWithPassword: vi.fn().mockResolvedValue(user) },
        repo: {
          findByUserAndProvider: vi
            .fn()
            .mockResolvedValue(buildLinkedAccount({ userId: user._id })),
          findByUserId: vi.fn().mockResolvedValue([buildLinkedAccount({ userId: user._id })]),
        },
      });

      await service.unlinkGoogle(String(user._id), { currentPassword: "pw" });

      expect(repo.deleteByUserAndProvider).toHaveBeenCalledWith(String(user._id), "GOOGLE");
    });

    it("blocks removing the last sign-in method (no password, no other provider)", async () => {
      const user = buildUser({ passwordHash: "" });
      const { service, repo } = makeService({
        users: { findByIdWithPassword: vi.fn().mockResolvedValue(user) },
        repo: {
          findByUserAndProvider: vi
            .fn()
            .mockResolvedValue(buildLinkedAccount({ userId: user._id })),
          findByUserId: vi.fn().mockResolvedValue([buildLinkedAccount({ userId: user._id })]),
        },
      });

      await expect(
        service.unlinkGoogle(String(user._id), { currentPassword: "pw" }),
      ).rejects.toMatchObject({
        statusCode: 409,
        details: [{ code: "LINKED_ACCOUNT_LAST_CREDENTIAL" }],
      });
      expect(repo.deleteByUserAndProvider).not.toHaveBeenCalled();
    });
  });

  describe("listForUser", () => {
    it("maps documents to the public summary shape (no providerAccountId)", async () => {
      const { service } = makeService({
        repo: {
          findByUserId: vi.fn().mockResolvedValue([
            buildLinkedAccount({
              email: "person@gmail.com",
              displayName: "Person Example",
              linkedAt: new Date("2026-09-01T10:00:00.000Z"),
            }),
          ]),
        },
      });

      const summaries = await service.listForUser("user-1");

      expect(summaries).toEqual([
        {
          provider: "GOOGLE",
          email: "person@gmail.com",
          displayName: "Person Example",
          linkedAt: "2026-09-01T10:00:00.000Z",
        },
      ]);
    });
  });
});
