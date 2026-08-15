import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import multer from "multer";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { env } from "../../config/env.js";
import { BusinessRepository } from "../business/business.repository.js";
import { StaffRepository } from "../staff/staff.repository.js";
import { staffIdParamsSchema } from "../staff/staff.schema.js";
import { createDeferredStorageServiceFromEnv } from "../storage/storage.service.js";
import { StaffAvatarController } from "./staff-avatar.controller.js";
import { StaffAvatarError } from "./staff-avatar.errors.js";
import { StaffAvatarRepository } from "./staff-avatar.repository.js";
import { StaffAvatarService } from "./staff-avatar.service.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.STAFF_AVATAR_MAX_UPLOAD_BYTES,
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
      next(new StaffAvatarError("STAFF_AVATAR_TOO_LARGE", 413));
      return;
    }

    next(error);
  });
};

/** Mounted inside business.route.ts, underneath its existing BUSINESS_OWNER gate. */
export const createStaffAvatarRoute = (): Router => {
  const router = Router({ mergeParams: true });
  const staffAvatarRepository = new StaffAvatarRepository();
  const businessRepository = new BusinessRepository();
  const staffRepository = new StaffRepository();
  const storageService = createDeferredStorageServiceFromEnv();
  const service = new StaffAvatarService(
    staffAvatarRepository,
    businessRepository,
    staffRepository,
    storageService,
    { maxUploadBytes: env.STAFF_AVATAR_MAX_UPLOAD_BYTES },
  );
  const controller = new StaffAvatarController(service);

  router.put(
    "/:businessId/staff/:staffId/avatar",
    validateRequest({ params: staffIdParamsSchema }),
    uploadSingleImage,
    asyncHandler(controller.upload),
  );

  return router;
};
