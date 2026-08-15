import { logger } from "../../config/logger.js";
import { createStorageServiceFromEnv, isStorageConfigured } from "./storage.service.js";

export const bootstrapStorage = async (): Promise<void> => {
  if (!isStorageConfigured()) {
    logger.warn(
      "Object storage is not fully configured; media endpoints will fail until S3 env is set",
    );
    return;
  }

  const storageService = createStorageServiceFromEnv();
  await storageService.ensureBucket();
  logger.info({ bucket: storageService.bucket }, "Object storage bucket is ready");
};
