import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_SERVICES_PER_BOOKING,
  DEFAULT_NO_SHOW_CATEGORY_WINDOWS,
} from "../../src/modules/platform-settings/platform-settings.constants.js";
import type { PlatformSettingsRepository } from "../../src/modules/platform-settings/platform-settings.repository.js";
import { PlatformSettingsService } from "../../src/modules/platform-settings/platform-settings.service.js";

function setup(current: unknown) {
  const repo = { findSingleton: vi.fn().mockResolvedValue(current), update: vi.fn() };
  return {
    repo,
    service: new PlatformSettingsService(repo as unknown as PlatformSettingsRepository),
  };
}
describe("platform settings read-only defaults", () => {
  it("returns canonical defaults without a write", async () => {
    const { repo, service } = setup(null);
    expect((await service.getSettings()).editable.maxServicesPerBooking).toBe(
      DEFAULT_MAX_SERVICES_PER_BOOKING,
    );
    expect(await service.getMaxServicesPerBooking()).toBe(DEFAULT_MAX_SERVICES_PER_BOOKING);
    expect(await service.resolveNoShowWindow("BEAUTY_WELLNESS")).toEqual(
      DEFAULT_NO_SHOW_CATEGORY_WINDOWS[0],
    );
    expect(repo.findSingleton).toHaveBeenCalledTimes(3);
    expect(repo.update).not.toHaveBeenCalled();
  });
  it("preserves the admin value", async () => {
    const { service } = setup({
      maxServicesPerBooking: 9,
      noShowCategoryWindows: DEFAULT_NO_SHOW_CATEGORY_WINDOWS,
    });
    expect(await service.getMaxServicesPerBooking()).toBe(9);
    expect((await service.getSettings()).editable.maxServicesPerBooking).toBe(9);
  });
  it("propagates database failures", async () => {
    const { repo, service } = setup(null);
    repo.findSingleton.mockRejectedValue(new Error("database unavailable"));
    await expect(service.getSettings()).rejects.toThrow("database unavailable");
    await expect(service.getMaxServicesPerBooking()).rejects.toThrow("database unavailable");
  });
});
