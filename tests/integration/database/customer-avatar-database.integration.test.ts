import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CustomerAvatarService } from "../../../src/modules/customer-avatar/customer-avatar.service.js";
import type { StorageService } from "../../../src/modules/storage/storage.service.js";
import { CustomerProfileModel, UserModel } from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

class FakeStorageService implements StorageService {
  public readonly bucket = "it-media";
  public readonly objects = new Map<string, Buffer>();
  public putObject = vi.fn(async (input: { key: string; body: Buffer }) => {
    this.objects.set(input.key, input.body);
  });
  public deleteObject = vi.fn(async (input: { key: string }) => {
    this.objects.delete(input.key);
  });
  public ensureBucket = vi.fn(async () => undefined);
  public getObjectUrl = vi.fn(async (input: { key: string }) => `https://cdn.example/${input.key}`);
  public objectExists = vi.fn(async (input: { key: string }) => this.objects.has(input.key));
}

const createCustomerUser = async (email: string): Promise<string> => {
  const user = await UserModel.create({
    normalizedEmail: email,
    passwordHash: "x",
    role: "CUSTOMER",
    status: "ACTIVE",
    security: { passwordUpdatedAt: new Date() },
  });
  return String(user._id);
};

describe("customer avatar — database-backed", () => {
  const storage = new FakeStorageService();
  const userRepository = new UserRepository();
  const service = new CustomerAvatarService(userRepository, storage, {
    maxUploadBytes: 5 * 1024 * 1024,
  });

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    storage.objects.clear();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  it("persists the avatar reference on the customer's own CustomerProfile row (row created on the fly)", async () => {
    const userId = await createCustomerUser("a@example.com");

    const { avatarUrl } = await service.uploadOrReplaceAvatar(userId, {
      buffer: jpeg,
      mimeType: "image/jpeg",
      size: jpeg.length,
    });

    const row = await CustomerProfileModel.findOne({ userId }).lean();
    expect(row?.avatar?.storageKey).toMatch(new RegExp(`^users/${userId}/avatar/.+\\.jpg$`));
    expect(row?.avatar?.bucket).toBe("it-media");
    expect(row?.avatar?.size).toBe(jpeg.length);
    expect(avatarUrl).toBe(`https://cdn.example/${row?.avatar?.storageKey}`);
    // Bytes live in the object store, never in Mongo.
    expect(JSON.stringify(row)).not.toContain(jpeg.toString("base64"));
    expect(storage.objects.size).toBe(1);
  });

  it("getMe-style resolveAvatarUrl reflects the persisted value and is undefined when unset", async () => {
    const userId = await createCustomerUser("b@example.com");

    const before = await userRepository.findCustomerProfileByUserId(userId);
    await expect(service.resolveAvatarUrl(before)).resolves.toBeUndefined();

    await service.uploadOrReplaceAvatar(userId, {
      buffer: jpeg,
      mimeType: "image/jpeg",
      size: jpeg.length,
    });

    const after = await userRepository.findCustomerProfileByUserId(userId);
    await expect(service.resolveAvatarUrl(after)).resolves.toMatch(
      /^https:\/\/cdn\.example\/users\//,
    );
  });

  it("replace keeps exactly one row, retires the old object only after the new one is persisted", async () => {
    const userId = await createCustomerUser("c@example.com");

    await service.uploadOrReplaceAvatar(userId, {
      buffer: jpeg,
      mimeType: "image/jpeg",
      size: jpeg.length,
    });
    const firstKey =
      (await CustomerProfileModel.findOne({ userId }).lean())?.avatar?.storageKey ?? "";

    await service.uploadOrReplaceAvatar(userId, {
      buffer: png,
      mimeType: "image/png",
      size: png.length,
    });
    const rows = await CustomerProfileModel.find({ userId }).lean();
    const secondKey = rows[0]?.avatar?.storageKey ?? "";

    expect(rows).toHaveLength(1);
    expect(secondKey).not.toBe(firstKey);
    expect(secondKey).toMatch(/\.png$/);
    expect(storage.deleteObject).toHaveBeenCalledWith({ key: firstKey });
    expect(storage.objects.has(firstKey)).toBe(false);
    expect(storage.objects.has(secondKey)).toBe(true);
  });

  it("a persistence failure after object upload rolls back the new object and leaves the previous avatar intact", async () => {
    const userId = await createCustomerUser("d@example.com");
    await service.uploadOrReplaceAvatar(userId, {
      buffer: jpeg,
      mimeType: "image/jpeg",
      size: jpeg.length,
    });
    const firstKey =
      (await CustomerProfileModel.findOne({ userId }).lean())?.avatar?.storageKey ?? "";

    const spy = vi
      .spyOn(userRepository, "setCustomerAvatar")
      .mockRejectedValueOnce(new Error("write concern failure"));

    await expect(
      service.uploadOrReplaceAvatar(userId, {
        buffer: png,
        mimeType: "image/png",
        size: png.length,
      }),
    ).rejects.toThrow("write concern failure");
    spy.mockRestore();

    const row = await CustomerProfileModel.findOne({ userId }).lean();
    expect(row?.avatar?.storageKey).toBe(firstKey);
    expect(storage.objects.has(firstKey)).toBe(true);
    // The orphan from the failed attempt was cleaned up.
    expect(storage.objects.size).toBe(1);
  });

  it("one customer's upload never touches another customer's avatar row", async () => {
    const userA = await createCustomerUser("e@example.com");
    const userB = await createCustomerUser("f@example.com");

    await service.uploadOrReplaceAvatar(userA, {
      buffer: jpeg,
      mimeType: "image/jpeg",
      size: jpeg.length,
    });
    const aKey = (await CustomerProfileModel.findOne({ userId: userA }).lean())?.avatar?.storageKey;

    await service.uploadOrReplaceAvatar(userB, {
      buffer: png,
      mimeType: "image/png",
      size: png.length,
    });

    const aRowAfter = await CustomerProfileModel.findOne({ userId: userA }).lean();
    const bRowAfter = await CustomerProfileModel.findOne({ userId: userB }).lean();
    expect(aRowAfter?.avatar?.storageKey).toBe(aKey);
    expect(aRowAfter?.avatar?.storageKey).toContain(`users/${userA}/avatar/`);
    expect(bRowAfter?.avatar?.storageKey).toContain(`users/${userB}/avatar/`);
    expect(new Types.ObjectId(userA).equals(userB)).toBe(false);
  });

  it("rejects a MIME/magic-byte mismatch without persisting or storing anything", async () => {
    const userId = await createCustomerUser("g@example.com");

    await expect(
      service.uploadOrReplaceAvatar(userId, {
        buffer: Buffer.from("totally not an image"),
        mimeType: "image/png",
        size: 20,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(storage.putObject).not.toHaveBeenCalled();
    expect(await CustomerProfileModel.findOne({ userId }).lean()).toBeNull();
  });
});
