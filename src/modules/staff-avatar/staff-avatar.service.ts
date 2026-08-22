import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { logger } from "../../config/logger.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { StaffRepository } from "../staff/staff.repository.js";
import type { StorageService } from "../storage/storage.service.js";
import { StaffAvatarError } from "./staff-avatar.errors.js";
import type { StaffAvatarDocument } from "./staff-avatar.model.js";
import type { StaffAvatarRepository } from "./staff-avatar.repository.js";

export type StaffAvatarUpload = {
  buffer: Buffer;
  mimeType: string;
  size: number;
  originalFileName?: string | undefined;
};

export type StaffAvatarUploadResult = {
  userId: string;
  avatarUrl: string;
};

type StaffAvatarServiceConfig = {
  maxUploadBytes: number;
};

const allowedImageMimeTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

type AllowedImageMimeType = (typeof allowedImageMimeTypes)[number];
type ValidStaffAvatarUpload = StaffAvatarUpload & { mimeType: AllowedImageMimeType };

const extensionByMimeType: Record<(typeof allowedImageMimeTypes)[number], string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * Staff/Supervisor avatar storage — deliberately separate from BusinessMedia (which is
 * Business-scoped with PROFILE/GALLERY roles). This is User-identity media: exactly one
 * current avatar per userId, authorized via the same owned-Business-only rule Staff
 * mutations use (see requireOwnedStaffBusiness below) — linked BusinessAccess grants no
 * Staff-avatar rights.
 */
export class StaffAvatarService {
  public constructor(
    private readonly staffAvatarRepository: StaffAvatarRepository,
    private readonly businessRepository: BusinessRepository,
    private readonly staffRepository: StaffRepository,
    private readonly storageService: StorageService,
    private readonly config: StaffAvatarServiceConfig,
  ) {}

  public async uploadOrReplaceAvatar(
    actorUserId: string,
    businessId: string,
    staffId: string,
    file: StaffAvatarUpload | undefined,
  ): Promise<StaffAvatarUploadResult> {
    const business = await this.requireOwnedStaffBusiness(actorUserId, businessId);

    const membership = await this.staffRepository.findActiveById(business._id, staffId);

    if (!membership) {
      // Covers: unknown id, soft-removed staff, and staff belonging to a different
      // Business — findActiveById already scopes by businessId.
      throw new StaffAvatarError("STAFF_AVATAR_STAFF_NOT_FOUND", 404);
    }

    const validFile = this.requireValidImage(file);
    const userId = membership.userId;
    const storageKey = this.buildStorageKey(userId, validFile.mimeType);

    const existing = await this.staffAvatarRepository.findByUserId(userId);
    // Snapshot before the repository call below — some repository implementations may
    // return/mutate the same document instance on replace, which would otherwise make this
    // key comparison always see the new value.
    const existingStorageKey = existing?.storageKey;

    await this.storageService.putObject({
      key: storageKey,
      body: validFile.buffer,
      contentType: validFile.mimeType,
      contentLength: validFile.size,
    });

    let saved: StaffAvatarDocument | null;

    try {
      saved = existing
        ? await this.staffAvatarRepository.replaceForUserId(userId, {
            storageKey,
            bucket: this.storageService.bucket,
            mimeType: validFile.mimeType,
            size: validFile.size,
            originalFileName: validFile.originalFileName,
            createdBy: new Types.ObjectId(actorUserId),
          })
        : await this.staffAvatarRepository.create({
            userId,
            storageKey,
            bucket: this.storageService.bucket,
            mimeType: validFile.mimeType,
            size: validFile.size,
            originalFileName: validFile.originalFileName,
            createdBy: new Types.ObjectId(actorUserId),
          });
    } catch (error) {
      // DB write failed after the object was written — roll back the orphaned object.
      await this.storageService.deleteObject({ key: storageKey });
      throw error;
    }

    if (!saved) {
      // existing row vanished between findByUserId and replaceForUserId (race) — roll back
      // the orphaned object rather than leaving it unreferenced.
      await this.storageService.deleteObject({ key: storageKey });
      throw new StaffAvatarError("STAFF_AVATAR_STAFF_NOT_FOUND", 404);
    }

    if (existingStorageKey && existingStorageKey !== saved.storageKey) {
      try {
        await this.storageService.deleteObject({ key: existingStorageKey });
      } catch (cleanupError) {
        // Non-fatal: the new avatar is already live and persisted. Log and move on rather
        // than failing a successful replace over a stale-object cleanup issue.
        logger.warn(
          { userId: String(userId), staleKey: existingStorageKey, error: cleanupError },
          "Failed to delete previous staff avatar object after replace",
        );
      }
    }

    return {
      userId: String(userId),
      avatarUrl: await this.storageService.getObjectUrl({ key: saved.storageKey }),
    };
  }

  public async getAvatarUrlsByUserIds(userIds: string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) {
      return new Map();
    }

    const rows = await this.staffAvatarRepository.findManyByUserIds(userIds);

    const entries = await Promise.all(
      rows.map(async (row) => {
        const url = await this.storageService.getObjectUrl({ key: row.storageKey });
        return [String(row.userId), url] as const;
      }),
    );

    return new Map(entries);
  }

  /**
   * Staff-Management-specific authorization, duplicated from staff.service.ts's identical
   * check rather than shared, matching this codebase's existing convention of each domain
   * service owning its full authorization surface. Owner-only — BusinessAccess (linked
   * Business) is never consulted, even though it remains valid for other Bookly features.
   *
   * 404 (never a bare 403) on every mismatch — see the identical rationale on
   * StaffService.requireOwnedStaffBusiness.
   */
  private async requireOwnedStaffBusiness(
    actorUserId: string,
    businessId: string,
  ): Promise<BusinessDocument> {
    this.requireValidObjectId(businessId);
    const business = await this.businessRepository.findById(businessId);

    if (!business) {
      throw new StaffAvatarError("STAFF_AVATAR_BUSINESS_NOT_FOUND", 404);
    }

    if (!business.ownerUserId.equals(actorUserId)) {
      throw new StaffAvatarError("STAFF_AVATAR_BUSINESS_NOT_FOUND", 404);
    }

    return business;
  }

  private requireValidObjectId(value: string): void {
    if (!/^[a-f\d]{24}$/i.test(value)) {
      throw new StaffAvatarError("STAFF_AVATAR_BUSINESS_NOT_FOUND", 404);
    }
  }

  private requireValidImage(file: StaffAvatarUpload | undefined): ValidStaffAvatarUpload {
    if (!file) {
      throw new StaffAvatarError("STAFF_AVATAR_FILE_REQUIRED", 400);
    }

    if (file.size > this.config.maxUploadBytes) {
      throw new StaffAvatarError("STAFF_AVATAR_TOO_LARGE", 413);
    }

    if (
      !this.isAllowedImageMimeType(file.mimeType) ||
      !this.bufferMatchesMime(file.buffer, file.mimeType)
    ) {
      throw new StaffAvatarError("STAFF_AVATAR_INVALID_TYPE", 400);
    }

    return file as ValidStaffAvatarUpload;
  }

  private isAllowedImageMimeType(mimeType: string): mimeType is AllowedImageMimeType {
    return allowedImageMimeTypes.includes(mimeType as (typeof allowedImageMimeTypes)[number]);
  }

  private bufferMatchesMime(buffer: Buffer, mimeType: string): boolean {
    if (mimeType === "image/jpeg") {
      return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    }

    if (mimeType === "image/png") {
      return buffer
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }

    if (mimeType === "image/webp") {
      return (
        buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WEBP"
      );
    }

    if (mimeType === "image/gif") {
      const signature = buffer.subarray(0, 6).toString("ascii");
      return signature === "GIF87a" || signature === "GIF89a";
    }

    return false;
  }

  private buildStorageKey(userId: Types.ObjectId, mimeType: AllowedImageMimeType): string {
    return `users/${String(userId)}/avatar/${randomUUID()}.${extensionByMimeType[mimeType]}`;
  }
}
