import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import multer from "multer";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { env } from "../../config/env.js";
import { BusinessRepository } from "../business/business.repository.js";
import { businessIdParamsSchema } from "../business/business.schema.js";
import { BusinessAccessRepository } from "../business/business-access.repository.js";
import { createDeferredStorageServiceFromEnv } from "../storage/storage.service.js";
import { BusinessMediaController } from "./business-media.controller.js";
import { BusinessMediaError } from "./business-media.errors.js";
import { BusinessMediaRepository } from "./business-media.repository.js";
import { mediaIdParamsSchema } from "./business-media.schema.js";
import { BusinessMediaService } from "./business-media.service.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.BUSINESS_MEDIA_MAX_UPLOAD_BYTES,
    files: 1,
  },
});

const uploadSingleImage: RequestHandler = (
  request: Request,
  response: Response,
  next: NextFunction,
): void => {
  upload.single("file")(request, response, (error: unknown) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      next(new BusinessMediaError("BUSINESS_MEDIA_TOO_LARGE", 413));
      return;
    }

    next(error);
  });
};

export const createBusinessMediaRoute = (): Router => {
  const router = Router({ mergeParams: true });
  const businessRepository = new BusinessRepository();
  const businessAccessRepository = new BusinessAccessRepository();
  const businessMediaRepository = new BusinessMediaRepository();
  const storageService = createDeferredStorageServiceFromEnv();
  const service = new BusinessMediaService(
    businessMediaRepository,
    businessRepository,
    businessAccessRepository,
    storageService,
    { maxUploadBytes: env.BUSINESS_MEDIA_MAX_UPLOAD_BYTES },
  );
  const controller = new BusinessMediaController(service);

  router.get(
    "/:businessId/media",
    validateRequest({ params: businessIdParamsSchema }),
    asyncHandler(controller.list),
  );
  router.post(
    "/:businessId/media",
    validateRequest({ params: businessIdParamsSchema }),
    uploadSingleImage,
    asyncHandler(controller.upload),
  );
  router.delete(
    "/:businessId/media/:mediaId",
    validateRequest({ params: mediaIdParamsSchema }),
    asyncHandler(controller.remove),
  );
  router.patch(
    "/:businessId/media/:mediaId/profile",
    validateRequest({ params: mediaIdParamsSchema }),
    asyncHandler(controller.setProfile),
  );

  return router;
};
