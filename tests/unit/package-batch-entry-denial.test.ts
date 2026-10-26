import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BookingCreationClaimModel,
  claimInternalPackageBatch,
  commitInternalPackageBatch,
  loadOwnedPackageBatch,
  prepareInternalPackageBatch,
  readOwnedPackageBatchMaterialization,
  releaseKnownAbortedPackageBatch,
} from "../../src/modules/booking/booking-creation-claim.model.js";
import { PackageBatchPersistence } from "../../src/modules/booking/package-batch-persistence.js";

// No activation mock in this file; deliberately forged inputs must not reach persistence.
describe("F1-40 production batch entry denies before purchase writes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it.each([
    ["prepare", prepareInternalPackageBatch],
    ["claim", claimInternalPackageBatch],
    ["commit", commitInternalPackageBatch],
    ["abort-reset", releaseKnownAbortedPackageBatch],
  ] as const)(
    "%s cannot use a forged DTO as authority even with consent configured true",
    async (_name, entry) => {
      vi.stubEnv("PACKAGE_CONSENT_ENABLED", "true");
      const read = vi.spyOn(BookingCreationClaimModel, "findOne");
      const write = vi.spyOn(BookingCreationClaimModel, "updateOne");
      await expect(Reflect.apply(entry, undefined, [{}, {}, {}, {}])).rejects.toMatchObject({
        code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE",
        statusCode: 503,
      });
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    },
  );
  it("the actual writer denies before inspecting forged identity or dependency ports", async () => {
    vi.stubEnv("PACKAGE_CONSENT_ENABLED", "true");
    const read = vi.spyOn(BookingCreationClaimModel, "findOne");
    // Dependency objects deliberately have no methods: reaching them would fail this denial.
    const writer = Reflect.construct(PackageBatchPersistence, [{}, {}]);
    expect(Reflect.get(writer, "writeInTransaction")).toBeUndefined();
    await expect(
      Reflect.apply(PackageBatchPersistence.prototype.materialize, writer, [{ customer: {} }]),
    ).rejects.toMatchObject({ code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE" });
    expect(read).not.toHaveBeenCalled();
  });
  it("the joined-session F2 seam also denies before using a caller session or dependency ports", async () => {
    vi.stubEnv("PACKAGE_CONSENT_ENABLED", "true");
    const read = vi.spyOn(BookingCreationClaimModel, "findOne");
    const writer = Reflect.construct(PackageBatchPersistence, [{}, {}]);
    await expect(
      Reflect.apply(PackageBatchPersistence.prototype.materializeInSession, writer, [
        {},
        "forged",
        {},
      ]),
    ).rejects.toMatchObject({ code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE" });
    expect(read).not.toHaveBeenCalled();
  });
  it.each([loadOwnedPackageBatch, readOwnedPackageBatchMaterialization])(
    "readers reject structural Customer objects before lookup",
    async (entry) => {
      const read = vi.spyOn(BookingCreationClaimModel, "findOne");
      await expect(Reflect.apply(entry, undefined, [{ customer: {} }])).rejects.toThrow(
        "Verified Customer capability required",
      );
      expect(read).not.toHaveBeenCalled();
    },
  );
});
