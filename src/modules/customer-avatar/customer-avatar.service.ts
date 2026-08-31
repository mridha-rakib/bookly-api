import { randomUUID } from "node:crypto";

import { logger } from "../../config/logger.js";
import type { StorageService } from "../storage/storage.service.js";
import type { CustomerProfileDocument } from "../user/user.model.js";
import type { UserRepository } from "../user/user.repository.js";
import { CustomerAvatarError } from "./customer-avatar.errors.js";

export type CustomerAvatarUpload = {
  buffer: Buffer;
  mimeType: string;
  size: number;
};

export type CustomerAvatarUploadResult = {
  avatarUrl: string;
};

type CustomerAvatarServiceConfig = {
  maxUploadBytes: number;
};

// GIF is deliberately excluded (unlike the Staff avatar endpoint): the crop step always emits a
// still JPEG, there is no animated-avatar product intent, and narrowing the accepted set keeps
// the surface smaller. Magic-byte checks below cover exactly these three.
const allowedImageMimeTypes = ["image/jpeg", "image/png", "image/webp"] as const;

type AllowedImageMimeType = (typeof allowedImageMimeTypes)[number];
type ValidCustomerAvatarUpload = CustomerAvatarUpload & { mimeType: AllowedImageMimeType };

const extensionByMimeType: Record<AllowedImageMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * Customer self-service avatar storage. Own contract, never routed through Staff authorization
 * or Staff IDs — the acting user is always the authenticated Customer (userId from the session,
 * passed in by the controller). Exactly one current avatar per Customer, its storage reference
 * kept on that Customer's CustomerProfile row (see user.model.ts CustomerAvatarMetadata).
 *
 * Replacement is write-new-then-retire-old, identical in shape to StaffAvatarService: the
 * previous object is only deleted after the new object is stored AND its reference persisted,
 * so any failure leaves the existing avatar fully intact.
 */
export class CustomerAvatarService {
  public constructor(
    private readonly userRepository: UserRepository,
    private readonly storageService: StorageService,
    private readonly config: CustomerAvatarServiceConfig,
  ) {}

  public async uploadOrReplaceAvatar(
    userId: string,
    file: CustomerAvatarUpload | undefined,
  ): Promise<CustomerAvatarUploadResult> {
    const validFile = this.requireValidImage(file);
    const storageKey = this.buildStorageKey(userId, validFile.mimeType);

    const existing = await this.userRepository.findCustomerProfileByUserId(userId);
    // Snapshot before the write below in case the same document instance is later mutated.
    const existingStorageKey = existing?.avatar?.storageKey;

    await this.storageService.putObject({
      key: storageKey,
      body: validFile.buffer,
      contentType: validFile.mimeType,
      contentLength: validFile.size,
    });

    try {
      await this.userRepository.setCustomerAvatar(userId, {
        storageKey,
        bucket: this.storageService.bucket,
        mimeType: validFile.mimeType,
        size: validFile.size,
        updatedAt: new Date(),
      });
    } catch (error) {
      // DB write failed after the object was written — roll back the orphaned object so a
      // failed upload never leaves a predictable unreferenced file behind.
      await this.storageService.deleteObject({ key: storageKey });
      throw error;
    }

    if (existingStorageKey && existingStorageKey !== storageKey) {
      try {
        await this.storageService.deleteObject({ key: existingStorageKey });
      } catch (cleanupError) {
        // Non-fatal: the new avatar is already live and persisted. Log and move on rather than
        // failing a successful replace over a stale-object cleanup issue.
        logger.warn(
          { userId, staleKey: existingStorageKey, error: cleanupError },
          "Failed to delete previous customer avatar object after replace",
        );
      }
    }

    return { avatarUrl: await this.storageService.getObjectUrl({ key: storageKey }) };
  }

  /**
   * Resolves a ready-to-render URL for a CustomerProfile's stored avatar, or `undefined` when
   * none is set. Used by AuthService.getMe so the frontend never needs a second request.
   */
  public async resolveAvatarUrl(
    customerProfile: CustomerProfileDocument | null | undefined,
  ): Promise<string | undefined> {
    const storageKey = customerProfile?.avatar?.storageKey;

    if (!storageKey) {
      return undefined;
    }

    return this.storageService.getObjectUrl({ key: storageKey });
  }

  private requireValidImage(file: CustomerAvatarUpload | undefined): ValidCustomerAvatarUpload {
    if (!file || file.size < 1) {
      throw new CustomerAvatarError("CUSTOMER_AVATAR_FILE_REQUIRED", 400);
    }

    if (file.size > this.config.maxUploadBytes) {
      throw new CustomerAvatarError("CUSTOMER_AVATAR_TOO_LARGE", 413);
    }

    if (
      !this.isAllowedImageMimeType(file.mimeType) ||
      !this.bufferMatchesMime(file.buffer, file.mimeType)
    ) {
      throw new CustomerAvatarError("CUSTOMER_AVATAR_INVALID_TYPE", 400);
    }

    return file as ValidCustomerAvatarUpload;
  }

  private isAllowedImageMimeType(mimeType: string): mimeType is AllowedImageMimeType {
    return allowedImageMimeTypes.includes(mimeType as AllowedImageMimeType);
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

    return false;
  }

  private buildStorageKey(userId: string, mimeType: AllowedImageMimeType): string {
    // Server-generated key only — the client never influences the path (no filename, no
    // traversal surface). Unique per upload so a fresh URL naturally busts any cache.
    return `users/${userId}/avatar/${randomUUID()}.${extensionByMimeType[mimeType]}`;
  }
}
