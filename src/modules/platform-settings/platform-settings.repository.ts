import { type PlatformSettingsDocument, PlatformSettingsModel } from "./platform-settings.model.js";

export type PlatformSettingsPatch = {
  maxServicesPerBooking?: number;
  noShowCategoryWindows?: PlatformSettingsDocument["noShowCategoryWindows"];
};

export class PlatformSettingsRepository {
  /**
   * Lazily materialises the singleton with schema defaults on first ever read. `$setOnInsert`
   * only fires on insert, so an existing admin-edited document is returned untouched — a
   * restart / fresh process never overwrites persisted edits.
   */
  public async getOrCreate(): Promise<PlatformSettingsDocument> {
    return PlatformSettingsModel.findOneAndUpdate(
      { key: "SINGLETON" },
      { $setOnInsert: { key: "SINGLETON" } },
      {
        returnDocument: "after",
        upsert: true,
        setDefaultsOnInsert: true,
        runValidators: true,
      },
    ).orFail();
  }

  public async update(patch: PlatformSettingsPatch): Promise<PlatformSettingsDocument> {
    return PlatformSettingsModel.findOneAndUpdate(
      { key: "SINGLETON" },
      { $set: patch, $setOnInsert: { key: "SINGLETON" } },
      {
        returnDocument: "after",
        upsert: true,
        setDefaultsOnInsert: true,
        runValidators: true,
      },
    ).orFail();
  }
}
