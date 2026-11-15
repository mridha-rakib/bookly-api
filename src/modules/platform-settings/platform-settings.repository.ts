import { type PlatformSettingsDocument, PlatformSettingsModel } from "./platform-settings.model.js";

export type PlatformSettingsPatch = {
  maxServicesPerBooking?: number;
  noShowCategoryWindows?: PlatformSettingsDocument["noShowCategoryWindows"];
};

export class PlatformSettingsRepository {
  /** Read only: an absent singleton is handled by the service without persisting defaults. */
  public async findSingleton(): Promise<PlatformSettingsDocument | null> {
    return PlatformSettingsModel.findOne({ key: "SINGLETON" }).exec();
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
