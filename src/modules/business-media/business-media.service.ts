import { randomUUID } from "node:crypto";
import mongoose, { Types } from "mongoose";

import { BusinessError } from "../business/business.errors.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { BusinessAccessRepository } from "../business/business-access.repository.js";
import type { StorageService } from "../storage/storage.service.js";
import { BusinessMediaError } from "./business-media.errors.js";
import type { BusinessMediaDocument, BusinessMediaRole } from "./business-media.model.js";
import type { BusinessMediaRepository } from "./business-media.repository.js";

export type BusinessMediaUpload = {
  buffer: Buffer;
  mimeType: string;
  size: number;
  originalFileName?: string | undefined;
};

export type BusinessMediaDto = {
  id: string;
  businessId: string;
  role: BusinessMediaRole;
  url: string;
  mimeType: string;
  size: number;
  originalFileName?: string | undefined;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type BusinessMediaServiceConfig = {
  maxUploadBytes: number;
};

const allowedImageMimeTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

type AllowedImageMimeType = (typeof allowedImageMimeTypes)[number];
type ValidBusinessMediaUpload = BusinessMediaUpload & { mimeType: AllowedImageMimeType };

const extensionByMimeType: Record<(typeof allowedImageMimeTypes)[number], string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export class BusinessMediaService {
  public constructor(
    private readonly businessMediaRepository: BusinessMediaRepository,
    private readonly businessRepository: BusinessRepository,
    private readonly businessAccessRepository: BusinessAccessRepository,
    private readonly storageService: StorageService,
    private readonly config: BusinessMediaServiceConfig,
  ) {}

  public async listBusinessMedia(userId: string, businessId: string): Promise<BusinessMediaDto[]> {
    await this.requireReadableBusiness(userId, businessId);
    const media = await this.businessMediaRepository.listByBusinessId(businessId);
    return Promise.all(media.map((item) => this.toDto(item)));
  }

  public async uploadBusinessMedia(
    userId: string,
    businessId: string,
    file: BusinessMediaUpload | undefined,
  ): Promise<BusinessMediaDto> {
    const business = await this.requireOwnedBusiness(userId, businessId);
    const validFile = this.requireValidImage(file);
    const storageKey = this.buildStorageKey(businessId, validFile.mimeType);
    const sortOrder = await this.businessMediaRepository.countByBusinessId(businessId);

    await this.storageService.putObject({
      key: storageKey,
      body: validFile.buffer,
      contentType: validFile.mimeType,
      contentLength: validFile.size,
    });

    try {
      const media = await this.businessMediaRepository.create({
        businessId: business._id,
        storageKey,
        bucket: this.storageService.bucket,
        role: "GALLERY",
        mimeType: validFile.mimeType,
        size: validFile.size,
        originalFileName: validFile.originalFileName,
        sortOrder,
        createdBy: new Types.ObjectId(userId),
      });

      return this.toDto(media);
    } catch (error) {
      await this.storageService.deleteObject({ key: storageKey });
      throw error;
    }
  }

  public async deleteBusinessMedia(
    userId: string,
    businessId: string,
    mediaId: string,
  ): Promise<void> {
    await this.requireOwnedBusiness(userId, businessId);
    this.requireValidObjectId(mediaId);

    const deleted = await this.businessMediaRepository.deleteByIdForBusiness(businessId, mediaId);

    if (!deleted) {
      throw new BusinessMediaError("BUSINESS_MEDIA_NOT_FOUND", 404);
    }

    try {
      await this.storageService.deleteObject({ key: deleted.storageKey });
    } catch (error) {
      await this.businessMediaRepository.restore(deleted);
      throw error;
    }
  }

  public async setProfileMedia(
    userId: string,
    businessId: string,
    mediaId: string,
  ): Promise<BusinessMediaDto> {
    await this.requireOwnedBusiness(userId, businessId);
    this.requireValidObjectId(mediaId);

    let media: BusinessMediaDocument | null = null;
    const dbSession = await mongoose.startSession();

    try {
      await dbSession.withTransaction(async () => {
        media = await this.businessMediaRepository.setProfileRole(businessId, mediaId, dbSession);

        if (!media) {
          throw new BusinessMediaError("BUSINESS_MEDIA_NOT_FOUND", 404);
        }
      });
    } finally {
      await dbSession.endSession();
    }

    if (!media) {
      throw new BusinessMediaError("BUSINESS_MEDIA_NOT_FOUND", 404);
    }

    return this.toDto(media);
  }

  private async requireReadableBusiness(
    userId: string,
    businessId: string,
  ): Promise<BusinessDocument> {
    const business = await this.requireBusiness(businessId);

    if (business.ownerUserId.equals(userId)) {
      return business;
    }

    const access = await this.businessAccessRepository.findByUserAndBusiness(userId, businessId);

    if (!access) {
      throw new BusinessError("BUSINESS_ACCESS_DENIED", 403);
    }

    return business;
  }

  private async requireOwnedBusiness(
    userId: string,
    businessId: string,
  ): Promise<BusinessDocument> {
    const business = await this.requireBusiness(businessId);

    if (!business.ownerUserId.equals(userId)) {
      throw new BusinessError("BUSINESS_NOT_FOUND", 404);
    }

    return business;
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

  private requireValidImage(file: BusinessMediaUpload | undefined): ValidBusinessMediaUpload {
    if (!file) {
      throw new BusinessMediaError("BUSINESS_MEDIA_FILE_REQUIRED", 400);
    }

    if (file.size > this.config.maxUploadBytes) {
      throw new BusinessMediaError("BUSINESS_MEDIA_TOO_LARGE", 413);
    }

    if (
      !this.isAllowedImageMimeType(file.mimeType) ||
      !this.bufferMatchesMime(file.buffer, file.mimeType)
    ) {
      throw new BusinessMediaError("BUSINESS_MEDIA_INVALID_TYPE", 400);
    }

    return file as ValidBusinessMediaUpload;
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

  private buildStorageKey(businessId: string, mimeType: AllowedImageMimeType): string {
    return `businesses/${businessId}/media/${randomUUID()}.${extensionByMimeType[mimeType]}`;
  }

  private async toDto(media: BusinessMediaDocument): Promise<BusinessMediaDto> {
    const url = await this.storageService.getObjectUrl({ key: media.storageKey });

    return {
      id: String(media._id),
      businessId: String(media.businessId),
      role: media.role,
      url,
      mimeType: media.mimeType,
      size: media.size,
      originalFileName: media.originalFileName,
      sortOrder: media.sortOrder,
      createdAt: media.createdAt.toISOString(),
      updatedAt: media.updatedAt.toISOString(),
    };
  }
}
