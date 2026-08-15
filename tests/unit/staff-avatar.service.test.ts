import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BusinessDocument } from "../../src/modules/business/business.model.js";
import type { BusinessRepository } from "../../src/modules/business/business.repository.js";
import type { StaffMembershipDocument } from "../../src/modules/staff/staff.model.js";
import type { StaffRepository } from "../../src/modules/staff/staff.repository.js";
import type { StaffAvatarDocument } from "../../src/modules/staff-avatar/staff-avatar.model.js";
import type {
  CreateStaffAvatarInput,
  ReplaceStaffAvatarInput,
  StaffAvatarRepository,
} from "../../src/modules/staff-avatar/staff-avatar.repository.js";
import {
  StaffAvatarService,
  type StaffAvatarUpload,
} from "../../src/modules/staff-avatar/staff-avatar.service.js";
import type { StorageService } from "../../src/modules/storage/storage.service.js";

const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const textBuffer = Buffer.from("not an image");

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

const buildMembership = (
  overrides: Partial<StaffMembershipDocument> = {},
): StaffMembershipDocument =>
  ({
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    businessId: new Types.ObjectId(),
    role: "STAFF",
    employmentActive: true,
    createdByUserId: new Types.ObjectId(),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  }) as StaffMembershipDocument;

const buildUpload = (overrides: Partial<StaffAvatarUpload> = {}): StaffAvatarUpload => ({
  buffer: pngBuffer,
  mimeType: "image/png",
  size: pngBuffer.length,
  originalFileName: "avatar.png",
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

class FakeStaffAvatarRepository implements Partial<StaffAvatarRepository> {
  public readonly rows: StaffAvatarDocument[] = [];

  public readonly findByUserId = vi.fn(async (userId: Types.ObjectId | string) => {
    return this.rows.find((row) => row.userId.equals(userId)) ?? null;
  });

  public readonly findManyByUserIds = vi.fn(async (userIds: Array<Types.ObjectId | string>) => {
    if (userIds.length === 0) {
      return [];
    }

    return this.rows.filter((row) => userIds.some((id) => row.userId.equals(id)));
  });

  public readonly create = vi.fn(async (input: CreateStaffAvatarInput) => {
    const now = new Date();
    const document = {
      _id: new Types.ObjectId(),
      ...input,
      createdAt: now,
      updatedAt: now,
    } as StaffAvatarDocument;
    this.rows.push(document);
    return document;
  });

  public readonly replaceForUserId = vi.fn(
    async (userId: Types.ObjectId | string, input: ReplaceStaffAvatarInput) => {
      const row = this.rows.find((item) => item.userId.equals(userId));

      if (!row) {
        return null;
      }

      row.storageKey = input.storageKey;
      row.bucket = input.bucket;
      row.mimeType = input.mimeType;
      row.size = input.size;
      row.originalFileName = input.originalFileName;
      row.createdBy = input.createdBy;
      row.updatedAt = new Date();
      return row;
    },
  );
}

const createService = (
  input: {
    business?: BusinessDocument | null;
    membership?: StaffMembershipDocument | null;
    maxUploadBytes?: number;
  } = {},
) => {
  const ownerUserId = new Types.ObjectId();
  const business = input.business === undefined ? buildBusiness({ ownerUserId }) : input.business;
  const membership =
    input.membership === undefined
      ? buildMembership({ businessId: business?._id ?? new Types.ObjectId() })
      : input.membership;

  const businessRepository = {
    findById: vi.fn().mockResolvedValue(business),
  };
  const staffRepository = {
    findActiveById: vi.fn(async (businessId: Types.ObjectId | string, staffId: string) => {
      if (!membership) {
        return null;
      }

      return membership.businessId.equals(businessId) && String(membership._id) === staffId
        ? membership
        : null;
    }),
  };
  const staffAvatarRepository = new FakeStaffAvatarRepository();
  const storageService = new FakeStorageService();
  const service = new StaffAvatarService(
    staffAvatarRepository as unknown as StaffAvatarRepository,
    businessRepository as unknown as BusinessRepository,
    staffRepository as unknown as StaffRepository,
    storageService,
    { maxUploadBytes: input.maxUploadBytes ?? 1024 },
  );

  return {
    ownerUserId,
    business,
    membership,
    businessRepository,
    staffRepository,
    staffAvatarRepository,
    storageService,
    service,
  };
};

describe("StaffAvatarService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lets the owner upload a first avatar for an active staff member", async () => {
    const { service, business, membership, ownerUserId, staffAvatarRepository, storageService } =
      createService();

    const result = await service.uploadOrReplaceAvatar(
      String(ownerUserId),
      String(business?._id),
      String(membership?._id),
      buildUpload(),
    );

    expect(result.userId).toBe(String(membership?.userId));
    expect(result.avatarUrl).toContain(
      `https://signed.example/users/${String(membership?.userId)}/avatar/`,
    );
    expect(staffAvatarRepository.rows).toHaveLength(1);
    expect(storageService.putObject).toHaveBeenCalledTimes(1);
  });

  it("denies a linked (BusinessAccess-only) actor — BusinessAccess grants no Staff-avatar rights", async () => {
    const business = buildBusiness();
    const membership = buildMembership({ businessId: business._id });
    const linkedUserId = new Types.ObjectId();
    // A BusinessAccess link for linkedUserId->business would exist in the real DB in this
    // scenario, but the service never queries BusinessAccess at all — only ownership matters.
    const { service, storageService } = createService({ business, membership });

    await expect(
      service.uploadOrReplaceAvatar(
        String(linkedUserId),
        String(business._id),
        String(membership._id),
        buildUpload(),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(storageService.putObject).not.toHaveBeenCalled();
  });

  it("denies an unrelated user — business exists but no owner/access relationship (403)", async () => {
    const business = buildBusiness();
    const membership = buildMembership({ businessId: business._id });
    const { service, storageService } = createService({ business, membership });

    await expect(
      service.uploadOrReplaceAvatar(
        String(new Types.ObjectId()),
        String(business._id),
        String(membership._id),
        buildUpload(),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(storageService.putObject).not.toHaveBeenCalled();
  });

  it("denies a staffId that does not belong to this business (404)", async () => {
    const { service, business, ownerUserId, storageService } = createService({
      membership: null,
    });

    await expect(
      service.uploadOrReplaceAvatar(
        String(ownerUserId),
        String(business?._id),
        String(new Types.ObjectId()),
        buildUpload(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(storageService.putObject).not.toHaveBeenCalled();
  });

  it("denies a soft-removed staff member (404)", async () => {
    // findActiveById already filters removedAt at the query layer — simulate that by never
    // resolving a membership for this staffId, same as the "wrong business" case above.
    const { service, business, ownerUserId, storageService } = createService({
      membership: null,
    });

    await expect(
      service.uploadOrReplaceAvatar(
        String(ownerUserId),
        String(business?._id),
        String(new Types.ObjectId()),
        buildUpload(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(storageService.putObject).not.toHaveBeenCalled();
  });

  it("rejects invalid image MIME/content (400) without writing to storage", async () => {
    const { service, business, membership, ownerUserId, storageService } = createService();

    await expect(
      service.uploadOrReplaceAvatar(
        String(ownerUserId),
        String(business?._id),
        String(membership?._id),
        buildUpload({ buffer: textBuffer, mimeType: "image/png", size: textBuffer.length }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(storageService.putObject).not.toHaveBeenCalled();
  });

  it("rejects oversized uploads (413) without writing to storage", async () => {
    const { service, business, membership, ownerUserId, storageService } = createService({
      maxUploadBytes: 4,
    });

    await expect(
      service.uploadOrReplaceAvatar(
        String(ownerUserId),
        String(business?._id),
        String(membership?._id),
        buildUpload(),
      ),
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(storageService.putObject).not.toHaveBeenCalled();
  });

  it("replace: leaves exactly one row, writes the new object, deletes the old one", async () => {
    const { service, business, membership, ownerUserId, staffAvatarRepository, storageService } =
      createService();

    await service.uploadOrReplaceAvatar(
      String(ownerUserId),
      String(business?._id),
      String(membership?._id),
      buildUpload({ originalFileName: "first.png" }),
    );
    const firstKey = staffAvatarRepository.rows[0]?.storageKey ?? "";

    await service.uploadOrReplaceAvatar(
      String(ownerUserId),
      String(business?._id),
      String(membership?._id),
      buildUpload({ originalFileName: "second.png" }),
    );

    expect(staffAvatarRepository.rows).toHaveLength(1);
    expect(storageService.putObject).toHaveBeenCalledTimes(2);
    expect(storageService.deleteObject).toHaveBeenCalledTimes(1);
    expect(storageService.deleteObject).toHaveBeenCalledWith({ key: firstKey });
    await expect(storageService.objectExists({ key: firstKey })).resolves.toBe(false);
  });

  it("rolls back the new object if the metadata write fails", async () => {
    const { service, business, membership, ownerUserId, staffAvatarRepository, storageService } =
      createService();

    await service.uploadOrReplaceAvatar(
      String(ownerUserId),
      String(business?._id),
      String(membership?._id),
      buildUpload({ originalFileName: "first.png" }),
    );
    const firstKey = staffAvatarRepository.rows[0]?.storageKey ?? "";

    staffAvatarRepository.replaceForUserId.mockRejectedValueOnce(new Error("db unavailable"));

    await expect(
      service.uploadOrReplaceAvatar(
        String(ownerUserId),
        String(business?._id),
        String(membership?._id),
        buildUpload({ originalFileName: "second.png" }),
      ),
    ).rejects.toThrow("db unavailable");

    // Old row/object untouched; only the new (now-orphaned) object was rolled back.
    expect(staffAvatarRepository.rows).toHaveLength(1);
    expect(staffAvatarRepository.rows[0]?.storageKey).toBe(firstKey);
    await expect(storageService.objectExists({ key: firstKey })).resolves.toBe(true);
    expect(storageService.putObject).toHaveBeenCalledTimes(2);
    expect(storageService.deleteObject).toHaveBeenCalledTimes(1);
    expect(storageService.deleteObject).not.toHaveBeenCalledWith({ key: firstKey });
  });

  it("does not fail the replace if deleting the old object errors (non-fatal cleanup)", async () => {
    const { service, business, membership, ownerUserId, staffAvatarRepository, storageService } =
      createService();

    await service.uploadOrReplaceAvatar(
      String(ownerUserId),
      String(business?._id),
      String(membership?._id),
      buildUpload({ originalFileName: "first.png" }),
    );
    storageService.deleteObject.mockRejectedValueOnce(new Error("storage unavailable"));

    const result = await service.uploadOrReplaceAvatar(
      String(ownerUserId),
      String(business?._id),
      String(membership?._id),
      buildUpload({ originalFileName: "second.png" }),
    );

    expect(result.avatarUrl).toBeTruthy();
    expect(staffAvatarRepository.rows).toHaveLength(1);
  });

  it("getAvatarUrlsByUserIds([]) short-circuits with no repository/storage calls", async () => {
    const { service, staffAvatarRepository, storageService } = createService();

    const result = await service.getAvatarUrlsByUserIds([]);

    expect(result.size).toBe(0);
    expect(staffAvatarRepository.findManyByUserIds).not.toHaveBeenCalled();
    expect(storageService.getObjectUrl).not.toHaveBeenCalled();
  });

  it("getAvatarUrlsByUserIds batches in a single repository call and only returns found rows", async () => {
    const { service, business, membership, ownerUserId, storageService } = createService();
    await service.uploadOrReplaceAvatar(
      String(ownerUserId),
      String(business?._id),
      String(membership?._id),
      buildUpload(),
    );
    const noAvatarUserId = new Types.ObjectId();
    storageService.getObjectUrl.mockClear();

    const result = await service.getAvatarUrlsByUserIds([
      String(membership?.userId),
      String(noAvatarUserId),
    ]);

    expect(result.size).toBe(1);
    expect(result.has(String(membership?.userId))).toBe(true);
    expect(result.has(String(noAvatarUserId))).toBe(false);
    expect(storageService.getObjectUrl).toHaveBeenCalledTimes(1);
  });
});
