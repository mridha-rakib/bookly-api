import { env } from "../../config/env.js";
import { type BusinessCategoryKey, businessCategoryKeys } from "./business-category.js";
import {
  defaultNoShowWindowFor,
  getFixedPlatformRules,
  MIN_MAX_SERVICES_PER_BOOKING,
  type NoShowCategoryWindow,
  platformCategoryList,
  STRUCTURAL_MAX_SERVICES_PER_BOOKING,
} from "./platform-settings.constants.js";
import { PlatformSettingsError } from "./platform-settings.errors.js";
import type { PlatformSettingsDocument } from "./platform-settings.model.js";
import type {
  PlatformSettingsPatch,
  PlatformSettingsRepository,
} from "./platform-settings.repository.js";

export type UpdatePlatformSettingsInput = {
  maxServicesPerBooking?: number;
  noShowCategoryWindows?: NoShowCategoryWindow[];
};

export type PlatformSettingsDto = {
  /** Fixed product rules — read-only, sourced from backend constants, never persisted. */
  fixed: ReturnType<typeof getFixedPlatformRules>;
  /** Truthful current session/auth config (env-sourced). Display-only; not editable here. */
  session: {
    refreshTokenTtlDays: number;
    accessTokenTtlMinutes: number;
  };
  categories: Array<{ key: BusinessCategoryKey; label: string }>;
  editable: {
    maxServicesPerBooking: number;
    structuralMaxServicesPerBooking: number;
    noShowCategoryWindows: NoShowCategoryWindow[];
  };
};

export class PlatformSettingsService {
  public constructor(private readonly repository: PlatformSettingsRepository) {}

  public async getSettings(): Promise<PlatformSettingsDto> {
    const doc = await this.repository.getOrCreate();
    return this.toDto(doc);
  }

  /** The authoritative product limit for how many service lines one booking may contain. */
  public async getMaxServicesPerBooking(): Promise<number> {
    const doc = await this.repository.getOrCreate();
    return doc.maxServicesPerBooking;
  }

  /**
   * The currently-configured no-show eligibility window for a category, with the code default
   * filling in if the stored document predates that category key (see `mergedWindows`).
   */
  public async resolveNoShowWindow(
    categoryKey: BusinessCategoryKey,
  ): Promise<NoShowCategoryWindow> {
    const doc = await this.repository.getOrCreate();
    const merged = this.mergedWindows(doc);
    return merged.find((w) => w.categoryKey === categoryKey) ?? defaultNoShowWindowFor(categoryKey);
  }

  public async updateSettings(input: UpdatePlatformSettingsInput): Promise<PlatformSettingsDto> {
    const patch: PlatformSettingsPatch = {};

    if (input.maxServicesPerBooking !== undefined) {
      // Defense in depth beyond the Zod boundary.
      const value = input.maxServicesPerBooking;
      if (
        !Number.isInteger(value) ||
        value < MIN_MAX_SERVICES_PER_BOOKING ||
        value > STRUCTURAL_MAX_SERVICES_PER_BOOKING
      ) {
        throw new PlatformSettingsError("PLATFORM_SETTINGS_INVALID_MAX_SERVICES", 400);
      }
      patch.maxServicesPerBooking = value;
    }

    if (input.noShowCategoryWindows !== undefined) {
      patch.noShowCategoryWindows = this.normalizeWindows(input.noShowCategoryWindows);
    }

    if (patch.maxServicesPerBooking === undefined && patch.noShowCategoryWindows === undefined) {
      throw new PlatformSettingsError("PLATFORM_SETTINGS_NO_UPDATE_FIELDS", 400);
    }

    const doc = await this.repository.update(patch);
    return this.toDto(doc);
  }

  /** Exactly one entry per canonical key, canonical order — defense in depth beyond Zod. */
  private normalizeWindows(windows: NoShowCategoryWindow[]): NoShowCategoryWindow[] {
    const byKey = new Map<BusinessCategoryKey, NoShowCategoryWindow>();
    for (const window of windows) {
      if (
        !Number.isInteger(window.opensAfterMinutes) ||
        !Number.isInteger(window.closesAfterMinutes) ||
        window.opensAfterMinutes < 0 ||
        window.opensAfterMinutes >= window.closesAfterMinutes
      ) {
        throw new PlatformSettingsError("PLATFORM_SETTINGS_INVALID_WINDOWS", 400);
      }
      byKey.set(window.categoryKey, {
        categoryKey: window.categoryKey,
        opensAfterMinutes: window.opensAfterMinutes,
        closesAfterMinutes: window.closesAfterMinutes,
      });
    }

    if (byKey.size !== businessCategoryKeys.length) {
      throw new PlatformSettingsError("PLATFORM_SETTINGS_INVALID_WINDOWS", 400);
    }

    return businessCategoryKeys.map((key) => {
      const window = byKey.get(key);
      if (!window) {
        throw new PlatformSettingsError("PLATFORM_SETTINGS_INVALID_WINDOWS", 400);
      }
      return window;
    });
  }

  private mergedWindows(doc: PlatformSettingsDocument): NoShowCategoryWindow[] {
    const byKey = new Map(doc.noShowCategoryWindows.map((w) => [w.categoryKey, w]));
    return businessCategoryKeys.map((key) => {
      const stored = byKey.get(key);
      return stored
        ? {
            categoryKey: key,
            opensAfterMinutes: stored.opensAfterMinutes,
            closesAfterMinutes: stored.closesAfterMinutes,
          }
        : defaultNoShowWindowFor(key);
    });
  }

  private toDto(doc: PlatformSettingsDocument): PlatformSettingsDto {
    return {
      fixed: getFixedPlatformRules(),
      session: {
        refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
        accessTokenTtlMinutes: env.JWT_ACCESS_TOKEN_TTL_MINUTES,
      },
      categories: platformCategoryList(),
      editable: {
        maxServicesPerBooking: doc.maxServicesPerBooking,
        structuralMaxServicesPerBooking: STRUCTURAL_MAX_SERVICES_PER_BOOKING,
        noShowCategoryWindows: this.mergedWindows(doc),
      },
    };
  }
}
