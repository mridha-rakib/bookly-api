/** biome-ignore-all lint/style/noNonNullAssertion: Fixture dimensions and successful reads are asserted by these tests; optional chaining would silently skip mutations. */
import mongoose, { type ClientSession, Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BusinessModel } from "../../../src/modules/business/business.model.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import {
  acquirePackageEligibilityFence,
  hasOutstandingPackageItem,
  withPackageEligibility,
} from "../../../src/modules/package-progress/package-eligibility.js";
import { PackageProgressV2Repository } from "../../../src/modules/package-progress/package-progress-v2.repository.js";
import { PackageModel } from "../../../src/modules/packages/package.model.js";
import { PackageRepository } from "../../../src/modules/packages/package.repository.js";
import { ServiceModel } from "../../../src/modules/services/service.model.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { packageV2Fixture, serviceFields, transaction } from "../../helpers/package-v2-fixture.js";
import { AFTER, prospectiveFixture } from "../../helpers/package-v2-prospective-fixture.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

describe("v2 structural dependency guards and Business fence", () => {
  const services = new ServiceRepository();
  const staff = new StaffRepository();
  const businesses = new BusinessRepository();
  beforeAll(async () => {
    expect(await connectIsolatedDatabase()).toMatch(/^bookly_auth_/);
    expect(mongoose.connection.host).toMatch(/^(127\.0\.0\.1|localhost)$/);
  }, 120000);
  beforeEach(clearIsolatedDatabase);
  afterAll(stopIsolatedReplicaSet);

  const mutation = async (
    f: Awaited<ReturnType<typeof packageV2Fixture>>,
    kind: string,
    session?: ClientSession,
  ) => {
    if (kind === "archive")
      return services.archiveById(f.business._id, f.services[0]!._id, session);
    if (kind === "provider") return staff.softRemoveById(f.business._id, f.provider._id, session);
    if (kind === "assignment")
      return services.replaceById(
        f.business._id,
        f.services[0]!._id,
        { ...serviceFields(f.services[0]!), assignedStaffMembershipIds: [] },
        session,
      );
    return businesses.updateOwnedById(
      f.ownerId,
      f.business._id,
      { visitType: "TRAVEL_TO_CUSTOMER" },
      session,
    );
  };
  it.each(["archive", "provider", "assignment", "mode"])(
    "denies %s when obligations exist, atomically rolling back the fence",
    async (kind) => {
      const f = await packageV2Fixture();
      const version = (await BusinessModel.findById(f.business._id))!.packageEligibilityVersion;
      await expect(mutation(f, kind)).rejects.toMatchObject({ statusCode: 409 });
      expect((await BusinessModel.findById(f.business._id))!.packageEligibilityVersion).toBe(
        version,
      );
      expect((await ServiceModel.findById(f.services[0]!._id))!.status).toBe("ACTIVE");
      await f.read();
    },
  );
  it.each(["DRAFT", "HOURLY", "PER_PERSON", "PACKAGE"])(
    "blocks Service replacement to %s for sold FIXED items",
    async (kind) => {
      const f = await packageV2Fixture();
      const fields = serviceFields(f.services[0]!);
      if (kind === "DRAFT") fields.status = "DRAFT";
      else if (kind === "PACKAGE") fields.isPackageDeal = true;
      else fields.pricingMode = kind as "HOURLY" | "PER_PERSON";
      await expect(
        services.replaceById(f.business._id, f.services[0]!._id, fields),
      ).rejects.toMatchObject({ statusCode: 409 });
      await f.read();
    },
  );
  it("protects employment deactivation and permits INACTIVE and nonstranding edits", async () => {
    const f = await packageV2Fixture();
    await expect(
      staff.updateActiveById(f.business._id, f.provider._id, { employmentActive: false }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      (await services.updateStatusById(f.business._id, f.services[0]!._id, "INACTIVE"))!.status,
    ).toBe("INACTIVE");
    const second = await staff.create({
      userId: new Types.ObjectId(),
      businessId: f.business._id,
      role: "STAFF",
      createdByUserId: f.ownerId,
    });
    for (const service of f.services)
      await services.replaceById(f.business._id, service._id, {
        ...serviceFields(service),
        assignedStaffMembershipIds: [second._id],
      });
    expect((await staff.softRemoveById(f.business._id, f.provider._id))!.removedAt).toBeDefined();
    expect(
      (await staff.updateActiveById(f.business._id, second._id, { role: "SUPERVISOR" }))!.role,
    ).toBe("SUPERVISOR");
    expect(
      (await businesses.updateOwnedById(f.ownerId, f.business._id, { name: "Renamed" }))!.name,
    ).toBe("Renamed");
  });
  it("protects zero remaining plus SCHEDULED, then permits archive when that item's obligation resolves", async () => {
    const f = await packageV2Fixture([1, 2]);
    expect((await f.read()).items[0]!.remainingSessions).toBe(0);
    await expect(services.archiveById(f.business._id, f.services[0]!._id)).rejects.toMatchObject({
      statusCode: 409,
    });
    await transaction((session) =>
      f.repository.resolve(f.scope(), f.input.originBookingId, "COMPLETED", session),
    );
    expect((await services.archiveById(f.business._id, f.services[0]!._id))!.status).toBe(
      "ARCHIVED",
    );
    expect((await f.read()).items[1]!.remainingSessions).toBe(2);
  });
  it("does not block removing A's provider solely because B has outstanding credits", async () => {
    const f = await packageV2Fixture([1, 2]);
    const bProvider = await staff.create({
      userId: new Types.ObjectId(),
      businessId: f.business._id,
      role: "STAFF",
      createdByUserId: f.ownerId,
    });
    await services.replaceById(f.business._id, f.services[1]!._id, {
      ...serviceFields(f.services[1]!),
      assignedStaffMembershipIds: [bProvider._id],
    });
    await transaction((session) =>
      f.repository.resolve(f.scope(), f.input.originBookingId, "COMPLETED", session),
    );
    expect((await staff.softRemoveById(f.business._id, f.provider._id))!.removedAt).toBeDefined();
    await f.read();
  });
  it.each(["archive", "provider", "assignment", "mode"])(
    "permits normal %s mutation when no v2 obligations exist",
    async (kind) => {
      const f = await packageV2Fixture(undefined, false);
      expect(await mutation(f, kind)).not.toBeNull();
      expect((await BusinessModel.findById(f.business._id))!.packageEligibilityVersion).toBe(1);
    },
  );
  it("keeps sold snapshots unchanged after fenced definition edit/archive", async () => {
    const f = await packageV2Fixture();
    const before = await f.read();
    const definitions = new PackageRepository();
    const edited = await definitions.replace(
      f.business._id,
      String(f.definition._id),
      1,
      {
        name: "New offer",
        category: f.definition.category,
        subcategory: f.definition.subcategory,
        serviceCategoryId: f.definition.serviceCategoryId,
        isFeatured: false,
        status: "ARCHIVED",
        items: [...f.definition.items].reverse(),
        bundlePriceCents: 50,
      },
      new Date(),
    );
    expect(edited!.revision).toBe(2);
    expect((await f.read()).purchaseSnapshot).toEqual(before.purchaseSnapshot);
    expect((await f.read()).items).toEqual(before.items);
  });

  for (const kind of ["archive", "provider", "assignment", "mode"]) {
    it(`serializes ${kind}: entitlement-first denies concurrent removal`, async () => {
      const f = await packageV2Fixture(undefined, false);
      let signal!: () => void;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const continueTransaction = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sale = transaction(async (session) => {
        await f.repository.create(f.input, session);
        signal();
        await continueTransaction;
      });
      await held;
      const remove = mutation(f, kind);
      const result = Promise.allSettled([sale, remove]);
      release();
      const [created, denied] = await result;
      expect(created!.status).toBe("fulfilled");
      expect(denied!.status).toBe("rejected");
      await f.read();
    });
    it(`serializes ${kind}: mutation-first denies concurrent entitlement creation`, async () => {
      const f = await packageV2Fixture(undefined, false);
      let signal!: () => void;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const continueTransaction = new Promise<void>((resolve) => {
        release = resolve;
      });
      const remove = transaction(async (session) => {
        await acquirePackageEligibilityFence(f.business._id, session);
        await mutation(f, kind, session);
        signal();
        await continueTransaction;
      });
      await held;
      const sale = transaction((session) => f.repository.create(f.input, session));
      const result = Promise.allSettled([remove, sale]);
      release();
      const [removed, denied] = await result;
      expect(removed!.status).toBe("fulfilled");
      expect(denied!.status).toBe("rejected");
      expect(await mongoose.connection.db!.collection("packageprogresses").countDocuments()).toBe(
        0,
      );
    });
  }
  it("defaults old Business fence reads to zero and initializes missing stored field atomically", async () => {
    const f = await packageV2Fixture(undefined, false);
    await BusinessModel.collection.updateOne(
      { _id: f.business._id },
      {
        $unset: { packageEligibilityVersion: "" },
        $set: { updatedAt: new Date("2020-01-01T00:00:00Z") },
      },
    );
    expect((await BusinessModel.findById(f.business._id))!.packageEligibilityVersion).toBe(0);
    await withPackageEligibility(f.business._id, undefined, async () => undefined);
    expect((await BusinessModel.findById(f.business._id))!.packageEligibilityVersion).toBe(1);
    expect((await BusinessModel.findById(f.business._id))!.updatedAt.toISOString()).toBe(
      "2020-01-01T00:00:00.000Z",
    );
  });
  it.each(["FINITE", "FOREVER"] as const)(
    "protects scheduled %s but excludes expired unscheduled FINITE R without a worker",
    async (mode) => {
      const f = await packageV2Fixture(undefined, false);
      const input = prospectiveFixture(f.input, mode);
      await PackageModel.updateOne(
        { _id: f.definition._id },
        {
          $set: {
            contractTerms: input.purchasedContract.definition.contractTerms,
            items: f.definition.items.map((item) => ({
              itemId: item.itemId,
              serviceId: item.serviceId,
              includedSessions: item.includedSessions,
              referenceUnitPriceCents: item.referenceUnitPriceCents,
              penaltyBasisCents: 5000,
            })),
          },
        },
      );
      const repository = new PackageProgressV2Repository(() => AFTER);
      await transaction((session) => repository.create(input, session));
      expect(
        await transaction((session) =>
          hasOutstandingPackageItem(f.business._id, f.services[0]!._id, session),
        ),
      ).toBe(true);
      expect(
        await transaction((session) =>
          hasOutstandingPackageItem(f.business._id, f.services[1]!._id, session),
        ),
      ).toBe(mode === "FOREVER");
      if (mode === "FINITE") {
        // Current fixture cutoff precedes this test's wall clock. Raw R remains unreconciled.
        expect(await services.archiveById(f.business._id, f.services[1]!._id)).not.toBeNull();
        await expect(
          services.archiveById(f.business._id, f.services[0]!._id),
        ).rejects.toMatchObject({ statusCode: 409 });
        await transaction((session) =>
          repository.resolve(f.scope(), f.input.originBookingId, "COMPLETED", session),
        );
        expect(await staff.softRemoveById(f.business._id, f.provider._id)).not.toBeNull();
      }
    },
  );
  it("fails closed on malformed prospective expiry metadata during a dependency edit", async () => {
    const f = await packageV2Fixture();
    // Corruption injection, never an application write path.
    await mongoose.connection
      .db!.collection("packageprogresses")
      .updateOne({ _id: f.input._id }, { $set: { creditAccountingVersion: 2 } });
    await expect(services.archiveById(f.business._id, f.services[1]!._id)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await ServiceModel.findById(f.services[1]!._id))!.status).toBe("ACTIVE");
  });
});
