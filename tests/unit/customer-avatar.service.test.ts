import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CustomerAvatarService,
  type CustomerAvatarUpload,
} from "../../src/modules/customer-avatar/customer-avatar.service.js";
import type { StorageService } from "../../src/modules/storage/storage.service.js";
import type { CustomerProfileDocument } from "../../src/modules/user/user.model.js";
import type { UserRepository } from "../../src/modules/user/user.repository.js";

const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const textBuffer = Buffer.from("not an image at all");

const buildUpload = (overrides: Partial<CustomerAvatarUpload> = {}): CustomerAvatarUpload => ({
  buffer: jpegBuffer,
  mimeType: "image/jpeg",
  size: jpegBuffer.length,
  ...overrides,
});

class FakeStorageService implements StorageService {
  public readonly bucket = "test-media";
  public readonly objects = new Map<string, Buffer>();
  public readonly putObject = vi.fn(async (input: { key: string; body: Buffer }) => {
    this.objects.set(input.key, input.body);
  });
  public readonly deleteObject = vi.fn(async (input: { key: string }) => {
    this.objects.delete(input.key);
  });
  public readonly ensureBucket = vi.fn(async () => undefined);
  public readonly getObjectUrl = vi.fn(
    async (input: { key: string }) => `https://signed.example/${input.key}`,
  );
  public readonly objectExists = vi.fn(async (input: { key: string }) =>
    this.objects.has(input.key),
  );
}

const createService = (
  input: { existingProfile?: CustomerProfileDocument | null; maxUploadBytes?: number } = {},
) => {
  const userId = new Types.ObjectId();
  const stored: { profile: CustomerProfileDocument | null } = {
    profile: input.existingProfile === undefined ? null : input.existingProfile,
  };

  const userRepository = {
    findCustomerProfileByUserId: vi.fn(async () => stored.profile),
    setCustomerAvatar: vi.fn(
      async (
        _userId: Types.ObjectId | string,
        avatar: NonNullable<CustomerProfileDocument["avatar"]>,
      ) => {
        stored.profile = {
          ...(stored.profile ?? {
            _id: new Types.ObjectId(),
            userId,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
          avatar,
        } as CustomerProfileDocument;
      },
    ),
  };

  const storageService = new FakeStorageService();
  const service = new CustomerAvatarService(
    userRepository as unknown as UserRepository,
    storageService,
    { maxUploadBytes: input.maxUploadBytes ?? 1024 },
  );

  return { userId, userRepository, storageService, service, stored };
};

describe("CustomerAvatarService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads a first avatar, stores the object and persists the reference", async () => {
    const { service, userId, storageService, stored } = createService();

    const result = await service.uploadOrReplaceAvatar(String(userId), buildUpload());

    expect(result.avatarUrl).toContain(`https://signed.example/users/${String(userId)}/avatar/`);
    expect(storageService.putObject).toHaveBeenCalledTimes(1);
    expect(stored.profile?.avatar?.storageKey).toMatch(
      new RegExp(`^users/${String(userId)}/avatar/.+\\.jpg$`),
    );
    expect(stored.profile?.avatar?.bucket).toBe("test-media");
    expect(storageService.deleteObject).not.toHaveBeenCalled();
  });

  it("rejects a missing file (400) without writing to storage", async () => {
    const { service, userId, storageService } = createService();

    await expect(service.uploadOrReplaceAvatar(String(userId), undefined)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(storageService.putObject).not.toHaveBeenCalled();
  });

  it("rejects an unsupported MIME type (400) without writing to storage", async () => {
    const { service, userId, storageService } = createService();

    await expect(
      service.uploadOrReplaceAvatar(
        String(userId),
        buildUpload({
          buffer: Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
          mimeType: "image/gif",
          size: 6,
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(storageService.putObject).not.toHaveBeenCalled();
  });

  it("rejects a MIME/magic-byte mismatch (400) without writing to storage", async () => {
    const { service, userId, storageService } = createService();

    await expect(
      service.uploadOrReplaceAvatar(
        String(userId),
        buildUpload({ buffer: textBuffer, mimeType: "image/png", size: textBuffer.length }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(storageService.putObject).not.toHaveBeenCalled();
  });

  it("rejects an oversized upload (413) without writing to storage", async () => {
    const { service, userId, storageService } = createService({ maxUploadBytes: 4 });

    await expect(
      service.uploadOrReplaceAvatar(String(userId), buildUpload()),
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(storageService.putObject).not.toHaveBeenCalled();
  });

  it("replace: writes the new object, persists the new reference, deletes only the old object", async () => {
    const { service, userId, storageService, stored } = createService();

    await service.uploadOrReplaceAvatar(String(userId), buildUpload());
    const firstKey = stored.profile?.avatar?.storageKey ?? "";

    await service.uploadOrReplaceAvatar(
      String(userId),
      buildUpload({ buffer: pngBuffer, mimeType: "image/png", size: pngBuffer.length }),
    );
    const secondKey = stored.profile?.avatar?.storageKey ?? "";

    expect(secondKey).not.toBe(firstKey);
    expect(secondKey).toMatch(/\.png$/);
    expect(storageService.putObject).toHaveBeenCalledTimes(2);
    expect(storageService.deleteObject).toHaveBeenCalledTimes(1);
    expect(storageService.deleteObject).toHaveBeenCalledWith({ key: firstKey });
    await expect(storageService.objectExists({ key: firstKey })).resolves.toBe(false);
    await expect(storageService.objectExists({ key: secondKey })).resolves.toBe(true);
  });

  it("rolls back the newly-uploaded object if persisting the reference fails, leaving the old avatar intact", async () => {
    const { service, userId, storageService, userRepository, stored } = createService();

    await service.uploadOrReplaceAvatar(String(userId), buildUpload());
    const firstKey = stored.profile?.avatar?.storageKey ?? "";

    userRepository.setCustomerAvatar.mockRejectedValueOnce(new Error("db unavailable"));

    await expect(
      service.uploadOrReplaceAvatar(
        String(userId),
        buildUpload({ buffer: pngBuffer, mimeType: "image/png", size: pngBuffer.length }),
      ),
    ).rejects.toThrow("db unavailable");

    expect(stored.profile?.avatar?.storageKey).toBe(firstKey);
    await expect(storageService.objectExists({ key: firstKey })).resolves.toBe(true);
    expect(storageService.putObject).toHaveBeenCalledTimes(2);
    // Exactly one delete — the rolled-back new object, never the still-referenced old one.
    expect(storageService.deleteObject).toHaveBeenCalledTimes(1);
    expect(storageService.deleteObject).not.toHaveBeenCalledWith({ key: firstKey });
  });

  it("leaves the new avatar live if deleting the previous object errors (non-fatal cleanup)", async () => {
    const { service, userId, storageService, stored } = createService();

    await service.uploadOrReplaceAvatar(String(userId), buildUpload());
    storageService.deleteObject.mockRejectedValueOnce(new Error("storage unavailable"));

    const result = await service.uploadOrReplaceAvatar(
      String(userId),
      buildUpload({ buffer: pngBuffer, mimeType: "image/png", size: pngBuffer.length }),
    );

    expect(result.avatarUrl).toBeTruthy();
    expect(result.avatarUrl).toContain(stored.profile?.avatar?.storageKey ?? "NOPE");
  });

  it("keeps the last upload when called repeatedly", async () => {
    const { service, userId, stored } = createService();

    await service.uploadOrReplaceAvatar(String(userId), buildUpload());
    await service.uploadOrReplaceAvatar(
      String(userId),
      buildUpload({ buffer: pngBuffer, mimeType: "image/png", size: pngBuffer.length }),
    );
    await service.uploadOrReplaceAvatar(String(userId), buildUpload());

    expect(stored.profile?.avatar?.storageKey).toMatch(/\.jpg$/);
  });

  describe("resolveAvatarUrl", () => {
    it("returns undefined when the profile is null or has no avatar", async () => {
      const { service } = createService();

      await expect(service.resolveAvatarUrl(null)).resolves.toBeUndefined();
      await expect(
        service.resolveAvatarUrl({ _id: new Types.ObjectId() } as CustomerProfileDocument),
      ).resolves.toBeUndefined();
    });

    it("returns a URL for a stored avatar key", async () => {
      const { service } = createService();

      const url = await service.resolveAvatarUrl({
        avatar: {
          storageKey: "users/abc/avatar/x.jpg",
          bucket: "b",
          mimeType: "image/jpeg",
          size: 10,
          updatedAt: new Date(),
        },
      } as CustomerProfileDocument);

      expect(url).toBe("https://signed.example/users/abc/avatar/x.jpg");
    });
  });
});
