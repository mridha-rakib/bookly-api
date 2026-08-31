import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import type { UpdatePlatformSettingsBody } from "./platform-settings.schema.js";
import type { PlatformSettingsService } from "./platform-settings.service.js";

export class PlatformSettingsController {
  public constructor(private readonly service: PlatformSettingsService) {}

  /** SUPER_ADMIN — full settings (fixed read-only rules + editable values). */
  public get = async (_request: Request, response: Response): Promise<void> => {
    const settings = await this.service.getSettings();
    sendSuccess(response, 200, "Platform settings", settings);
  };

  /** SUPER_ADMIN — patch editable fields only. */
  public update = async (request: Request, response: Response): Promise<void> => {
    const body = request.validated?.body as UpdatePlatformSettingsBody;
    const settings = await this.service.updateSettings({
      ...(body.maxServicesPerBooking !== undefined
        ? { maxServicesPerBooking: body.maxServicesPerBooking }
        : {}),
      ...(body.noShowCategoryWindows !== undefined
        ? { noShowCategoryWindows: body.noShowCategoryWindows }
        : {}),
    });
    sendSuccess(response, 200, "Platform settings updated", settings);
  };

  /**
   * PUBLIC — only the fields the customer / business booking UIs need to mirror the
   * server-authoritative limit. Deliberately does NOT expose fixed financial rules or the
   * category windows.
   */
  public getPublicBookingConfig = async (_request: Request, response: Response): Promise<void> => {
    const maxServicesPerBooking = await this.service.getMaxServicesPerBooking();
    sendSuccess(response, 200, "Booking config", { maxServicesPerBooking });
  };
}
