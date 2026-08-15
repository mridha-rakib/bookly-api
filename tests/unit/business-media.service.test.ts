import mongoose, { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BusinessDocument } from "../../src/modules/business/business.model.js";
import type { BusinessRepository } from "../../src/modules/business/business.repository.js";
import type { BusinessAccessRepository } from "../../src/modules/business/business-access.repository.js";
import type {
  BusinessMediaDocument,
  BusinessMediaRole,
} from "../../src/modules/business-media/business-media.model.js";
import type { BusinessMediaRepository } from "../../src/modules/business-media/business-media.repository.js";
import {
  BusinessMediaService,
  type BusinessMediaUpload,
} from "../../src/modules/business-media/business-media.service.js";
import type { StorageService } from "../../src/modules/storage/storage.service.js";

const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const textBuffer = Buffer.from("not an image");

const createDbSession = () => ({
  withTransaction: vi.fn(async (callback: () => Promise<void>) => {
    await callback();
  }),
  endSession: vi.fn(),
});

const buildBusiness = (overrides: Partial<BusinessDocument> = {}): BusinessDocument =>
  ({
    _id: new Types.ObjectId(),
    ownerUserId: new Types.ObjectId(),
    name: "Bookly Studio",
    ownerName: "Owner Name",
    email: "owner@example.com",
    phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
    status: "PENDING",
    visitType: "AT_BUSINESS_LOCATION",
    address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
    briefDescription: "A great business",
    category: "Wellness",
    subcategories: ["Massage"],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  }) as BusinessDocument;

const buildUpload = (overrides: Partial<BusinessMediaUpload> = {}): BusinessMediaUpload => ({
  buffer: pngBuffer,
  mimeType: "image/png",
  size: pngBuffer.length,
  originalFileName: "studio.png",
  ...overrides,
});

class FakeStorageService implements StorageService {
  public readonly bucket = "test-media";
  public readonly objects = new Map<string, Buffer>();
  public readonly putObject = vi.fn(async (input) => {
    this.objects.set(input.key, input.body);
  });
  public readonly deleteObject = vi.fn(async (input) => {
    this.objects.delete(input.key);
  });
  public readonly ensureBucket = vi.fn(async () => undefined);
  public readonly getObjectUrl = vi.fn(async (input) => `https://signed.example/${input.key}`);
  public readonly objectExists = vi.fn(async (input) => this.objects.has(input.key));
}

class FakeBusinessMediaRepository implements Partial<BusinessMediaRepository> {
  public readonly media: BusinessMediaDocument[] = [];

  public async listByBusinessId(businessId: Types.ObjectId | string) {
    return this.media
      .filter((item) => item.businessId.equals(businessId))
      .sort((left, right) => left.sortOrder - right.sortOrder);
  }

  public async create(input: {
    businessId: Types.ObjectId;
    storageKey: string;
    bucket: string;
    role: BusinessMediaRole;
    mimeType: string;
    size: number;
    originalFileName?: string | undefined;
    sortOrder: number;
    createdBy: Types.ObjectId;
  }) {
    const now = new Date();
    const document = {
      _id: new Types.ObjectId(),
      ...input,
      createdAt: now,
      updatedAt: now,
    } as BusinessMediaDocument;
    this.media.push(document);
    return document;
  }

  public async countByBusinessId(businessId: Types.ObjectId | string) {
    return this.media.filter((item) => item.businessId.equals(businessId)).length;
  }

  public async deleteByIdForBusiness(
    businessId: Types.ObjectId | string,
    mediaId: Types.ObjectId | string,
  ) {
    const index = this.media.findIndex(
      (item) => item.businessId.equals(businessId) && item._id.equals(mediaId),
    );

    if (index < 0) {
      return null;
    }

    const [deleted] = this.media.splice(index, 1);
    return deleted ?? null;
  }

  public async restore(document: BusinessMediaDocument) {
    this.media.push(document);
    return document;
  }

  public async setProfileRole(
    businessId: Types.ObjectId | string,
    mediaId: Types.ObjectId | string,
  ) {
    const media = this.media.find(
      (item) => item.businessId.equals(businessId) && item._id.equals(mediaId),
    );

    if (!media) {
      return null;
    }

    for (const item of this.media) {
      if (item.businessId.equals(businessId) && item.role === "PROFILE") {
        item.role = "GALLERY";
      }
    }

    media.role = "PROFILE";
    media.updatedAt = new Date();
    return media;
  }
}

const createService = (
  input: { business?: BusinessDocument | null; linked?: boolean; maxUploadBytes?: number } = {},
) => {
  const ownerUserId = new Types.ObjectId();
  const business = input.business === undefined ? buildBusiness({ ownerUserId }) : input.business;
  const businessRepository = {
    findById: vi.fn().mockResolvedValue(business),
  };
  const businessAccessRepository = {
    findByUserAndBusiness: vi
      .fn()
      .mockResolvedValue(input.linked ? { _id: new Types.ObjectId() } : null),
  };
  const businessMediaRepository = new FakeBusinessMediaRepository();
  const storageService = new FakeStorageService();
  const service = new BusinessMediaService(
    businessMediaRepository as unknown as BusinessMediaRepository,
    businessRepository as unknown as BusinessRepository,
    businessAccessRepository as unknown as BusinessAccessRepository,
    storageService,
    { maxUploadBytes: input.maxUploadBytes ?? 1024 },
  );

  return {
    ownerUserId,
    business,
    businessRepository,
    businessAccessRepository,
    businessMediaRepository,
    storageService,
    service,
  };
};

describe("BusinessMediaService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(createDbSession() as unknown as never);
  });

  it("lets the owner upload an image, stores metadata, and writes the object", async () => {
    const { service, business, ownerUserId, businessMediaRepository, storageService } =
      createService();

    const result = await service.uploadBusinessMedia(
      String(ownerUserId),
      String(business?._id),
      buildUpload(),
    );

    expect(result.role).toBe("GALLERY");
    expect(result.url).toContain("https://signed.example/businesses/");
    expect(businessMediaRepository.media).toHaveLength(1);
    expect(businessMediaRepository.media[0]?.bucket).toBe(storageService.bucket);
    expect(businessMediaRepository.media[0]?.createdBy.equals(ownerUserId)).toBe(true);
    expect(storageService.putObject).toHaveBeenCalledTimes(1);
    await expect(
      storageService.objectExists({ key: businessMediaRepository.media[0]?.storageKey ?? "" }),
    ).resolves.toBe(true);
  });

  it("blocks a linked user from uploading", async () => {
    const ownerUserId = new Types.ObjectId();
    const business = buildBusiness({ ownerUserId });
    const linkedUserId = new Types.ObjectId();
    const { service, storageService } = createService({ business, linked: true });

    await expect(
      service.uploadBusinessMedia(String(linkedUserId), String(business._id), buildUpload()),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(storageService.putObject).not.toHaveBeenCalled();
  });

  it("blocks an unrelated user from uploading", async () => {
    const business = buildBusiness();
    const { service, storageService } = createService({ business });

    await expect(
      service.uploadBusinessMedia(
        String(new Types.ObjectId()),
        String(business._id),
        buildUpload(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(storageService.putObject).not.toHaveBeenCalled();
  });

  it("rejects invalid image MIME/content", async () => {
    const { service, business, ownerUserId, storageService } = createService();

    await expect(
      service.uploadBusinessMedia(
        String(ownerUserId),
        String(business?._id),
        buildUpload({ buffer: textBuffer, mimeType: "image/png", size: textBuffer.length }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(storageService.putObject).not.toHaveBeenCalled();
  });

  it("rejects oversized uploads", async () => {
    const { service, business, ownerUserId, storageService } = createService({ maxUploadBytes: 4 });

    await expect(
      service.uploadBusinessMedia(String(ownerUserId), String(business?._id), buildUpload()),
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(storageService.putObject).not.toHaveBeenCalled();
  });

  it("lists media for linked users but does not change ownership", async () => {
    const ownerUserId = new Types.ObjectId();
    const linkedUserId = new Types.ObjectId();
    const business = buildBusiness({ ownerUserId });
    const { service, businessMediaRepository } = createService({ business, linked: true });
    await businessMediaRepository.create({
      businessId: business._id,
      storageKey: "businesses/b1/media/one.png",
      bucket: "test-media",
      role: "GALLERY",
      mimeType: "image/png",
      size: pngBuffer.length,
      sortOrder: 0,
      createdBy: ownerUserId,
    });

    const result = await service.listBusinessMedia(String(linkedUserId), String(business._id));

    expect(result).toHaveLength(1);
    expect(business.ownerUserId.equals(ownerUserId)).toBe(true);
  });

  it("blocks unrelated users from listing media", async () => {
    const business = buildBusiness();
    const { service } = createService({ business });

    await expect(
      service.listBusinessMedia(String(new Types.ObjectId()), String(business._id)),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("deletes metadata and the storage object", async () => {
    const { service, business, ownerUserId, businessMediaRepository, storageService } =
      createService();
    const uploaded = await service.uploadBusinessMedia(
      String(ownerUserId),
      String(business?._id),
      buildUpload(),
    );
    const storageKey = businessMediaRepository.media[0]?.storageKey ?? "";

    await service.deleteBusinessMedia(String(ownerUserId), String(business?._id), uploaded.id);

    expect(businessMediaRepository.media).toHaveLength(0);
    expect(storageService.deleteObject).toHaveBeenCalledWith({ key: storageKey });
    await expect(storageService.objectExists({ key: storageKey })).resolves.toBe(false);
  });

  it("restores metadata if object deletion fails", async () => {
    const { service, business, ownerUserId, businessMediaRepository, storageService } =
      createService();
    const uploaded = await service.uploadBusinessMedia(
      String(ownerUserId),
      String(business?._id),
      buildUpload(),
    );
    storageService.deleteObject.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(
      service.deleteBusinessMedia(String(ownerUserId), String(business?._id), uploaded.id),
    ).rejects.toThrow("storage unavailable");
    expect(businessMediaRepository.media).toHaveLength(1);
  });

  it("switches profile role without duplicating objects and leaves only one profile image", async () => {
    const { service, business, ownerUserId, businessMediaRepository, storageService } =
      createService();
    const first = await service.uploadBusinessMedia(
      String(ownerUserId),
      String(business?._id),
      buildUpload({ originalFileName: "first.png" }),
    );
    const second = await service.uploadBusinessMedia(
      String(ownerUserId),
      String(business?._id),
      buildUpload({ originalFileName: "second.png" }),
    );

    await service.setProfileMedia(String(ownerUserId), String(business?._id), first.id);
    await service.setProfileMedia(String(ownerUserId), String(business?._id), second.id);

    expect(businessMediaRepository.media.filter((item) => item.role === "PROFILE")).toHaveLength(1);
    expect(businessMediaRepository.media.find((item) => String(item._id) === second.id)?.role).toBe(
      "PROFILE",
    );
    expect(storageService.putObject).toHaveBeenCalledTimes(2);
    expect(storageService.deleteObject).not.toHaveBeenCalled();
  });

  it("allows deleting the current profile image without changing business ownership", async () => {
    const { service, business, ownerUserId, businessMediaRepository } = createService();
    const uploaded = await service.uploadBusinessMedia(
      String(ownerUserId),
      String(business?._id),
      buildUpload(),
    );
    await service.setProfileMedia(String(ownerUserId), String(business?._id), uploaded.id);

    await service.deleteBusinessMedia(String(ownerUserId), String(business?._id), uploaded.id);

    expect(businessMediaRepository.media.filter((item) => item.role === "PROFILE")).toHaveLength(0);
    expect(business?.ownerUserId.equals(ownerUserId)).toBe(true);
  });
});
