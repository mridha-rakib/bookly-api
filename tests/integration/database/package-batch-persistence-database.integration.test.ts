import { appendFileSync } from "node:fs";
import mongoose, { type ClientSession, Types } from "mongoose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import * as claims from "../../../src/modules/booking/booking-creation-claim.model.js";
import {
  BookingCreationClaimModel,
  prepareInternalPackageBatch,
  readOwnedPackageBatchMaterialization,
} from "../../../src/modules/booking/booking-creation-claim.model.js";
import * as scheduling from "../../../src/modules/booking/booking-scheduling-admission.js";
import { hashCanonicalPackageCheckoutContent } from "../../../src/modules/booking/package-checkout-binding.js";
import { BookingSlotReservationModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.model.js";
import { BookingSlotReservationClaimModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation-claim.model.js";
import { BusinessModel } from "../../../src/modules/business/business.model.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { cancellationTiers } from "../../../src/modules/business-cancellation-policy/business-cancellation-policy.model.js";
import { BusinessCancellationPolicyRepository } from "../../../src/modules/business-cancellation-policy/business-cancellation-policy.repository.js";
import { BusinessClientModel } from "../../../src/modules/client/client.model.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { PackageProgressV2Model } from "../../../src/modules/package-progress/package-progress-v2.model.js";
import { PackageProgressV2Repository } from "../../../src/modules/package-progress/package-progress-v2.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { UserModel } from "../../../src/modules/user/user.model.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
import { packageBatchFixture } from "../../helpers/package-batch-fixture.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

vi.mock("../../../src/modules/booking/package-batch-authority.js", () => ({
  verifyPackageBatchActivation: vi.fn(async () => undefined),
}));

const gate = () => {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
};
let observedServerCodes: number[] = [];
const persisted = async () =>
  hashCanonicalPackageCheckoutContent({
    bookings: await BookingModel.find({}).sort({ _id: 1 }).lean(),
    progress: await PackageProgressV2Model.find({}).sort({ _id: 1 }).lean(),
    claims: await BookingCreationClaimModel.find({}).sort({ _id: 1 }).lean(),
    operations: await BookingSlotReservationClaimModel.find({}).sort({ _id: 1 }).lean(),
    days: await BookingSlotReservationModel.find({}).sort({ _id: 1 }).lean(),
    business: await BusinessModel.find({}).sort({ _id: 1 }).lean(),
    clients: await BusinessClientModel.find({}).sort({ _id: 1 }).lean(),
  });
const noNewMaterialization = async () => {
  expect(await BookingModel.countDocuments({})).toBe(0);
  expect(await PackageProgressV2Model.countDocuments({})).toBe(0);
  expect(await BookingSlotReservationClaimModel.countDocuments({})).toBe(0);
  expect(await BookingSlotReservationModel.countDocuments({})).toBe(0);
  expect(
    await BookingCreationClaimModel.countDocuments({
      packageBatchMaterialization: { $exists: true },
    }),
  ).toBe(0);
};
async function existingGroup(
  t: Awaited<ReturnType<typeof packageBatchFixture>>,
  partySize: number,
) {
  const a = t.quote.payload.appointments.find((a) => a.group);
  if (!a?.group) throw new Error("Missing Group fixture");
  return t.reservations.reserveOrJoin({
    businessId: t.scope.businessId,
    serviceId: a.serviceId,
    staffMembershipId: a.staffMembershipId,
    timezone: t.quote.payload.businessTimezone,
    startAt: a.startAt,
    endAt: a.endAt,
    capacityMax: a.group.capacityMax,
    partySize,
    idempotencyKey: `ordinary:${new Types.ObjectId()}`,
  });
}

describe("F1 internal canonical atomic materialization (test-module authority mock)", () => {
  beforeAll(connectIsolatedDatabase, 120000);
  beforeEach(async () => {
    await clearIsolatedDatabase();
    observedServerCodes = [];
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    // Optional external test evidence only; never imported or read by application code.
    const evidencePath = process.env["BOOKLY_F1_EVIDENCE_PATH"];
    if (!evidencePath) return;
    const canonical = await BookingCreationClaimModel.find({}).lean();
    const bookings = await BookingModel.find({}).lean();
    const progress = await PackageProgressV2Model.find({}).lean();
    appendFileSync(
      evidencePath,
      `${JSON.stringify({
        test: expect.getState().currentTestName,
        authority: "VITEST_MODULE_MOCK_INTERNAL_ONLY",
        initialDatabaseState: "cleared helper-owned disposable database",
        database: mongoose.connection.name,
        serverCodes: observedServerCodes,
        claims: canonical.map((c) => ({
          id: c._id,
          key: c.idempotencyKey,
          business: c.businessId,
          customer: c.actorUserId,
          origin: c.bookingId,
          quoteId: c.packageCheckoutRetention?.quote.payload.quoteId,
          termsHash: c.packageCheckoutRetention?.quote.termsHash,
          batch: c.packageCheckoutRetention?.quote.payload.batchId,
          progress: c.packageCheckoutRetention?.quote.payload.packageProgressId,
          retainedMembers: c.packageCheckoutRetention?.quote.payload.appointments.map((m) => ({
            bookingId: m.bookingId,
            selectionId: m.selectionId,
            item: m.packageItemId,
            service: m.serviceId,
            staff: m.staffMembershipId,
            start: m.startAt,
            end: m.endAt,
            group: m.group,
          })),
          phase: c.packageBatchControl?.phase,
          preparedMembers: c.packageBatchPreparation?.members,
          materialization: c.packageBatchMaterialization,
        })),
        bookings: bookings.map((b) => ({
          id: b._id,
          business: b.businessId,
          customer: b.customer.customerUserId,
          client: b.customer.businessClientId,
          schedule: b.schedule,
          status: b.status,
          lines: b.serviceLines.map((l) => ({
            service: l.serviceId,
            item: l.pricingInput.packageItemId,
            progress: l.pricingInput.packageProgressId,
            operation: l.reservationOperationKey,
            reservation: l.reservationId,
          })),
          financials: b.financials,
        })),
        progress: progress.map((p) => ({
          id: p._id,
          business: p.businessId,
          customer: p.customerUserId,
          client: p.businessClientId,
          origin: p.originBookingId,
          items: p.items,
          sessions: p.sessions,
        })),
        effects: await BookingSlotReservationClaimModel.find({}).lean(),
        days: await BookingSlotReservationModel.find({}).lean(),
        coordination: (await BusinessModel.find({}).lean()).map((b) => ({
          id: b._id,
          counter: b.packageEligibilityVersion,
        })),
        clientVersions: (await BusinessClientModel.find({}).lean()).map((c) => ({
          id: c._id,
          version: Reflect.get(c, "__v"),
          linkedUser: c.linkedUserId,
        })),
      })}\n`,
    );
  });
  afterAll(stopIsolatedReplicaSet);
  it("F1-01 two FIXED Services commit retained Bookings and one Progress together", async () => {
    const t = await packageBatchFixture();
    const result = await t.writer.materialize(t.scope);
    expect(result.kind).toBe("INTERNAL_MATERIALIZATION_ONLY");
    expect(result.commercialCompletion).toBe("NOT_ESTABLISHED");
    expect(result.bookings.map((b) => String(b._id)).sort()).toEqual(
      t.quote.payload.appointments.map((a) => String(a.bookingId)).sort(),
    );
    expect(await BookingModel.countDocuments({})).toBe(2);
    expect(await PackageProgressV2Model.countDocuments({})).toBe(1);
    expect(await readOwnedPackageBatchMaterialization(t.scope)).not.toBeNull();
  });
  it("F1-03 mixed FIXED and Group preserve explicit party one", async () => {
    const t = await packageBatchFixture({ group: true });
    const result = await t.writer.materialize(t.scope);
    expect(result.bookings).toHaveLength(2);
    expect(result.progress.items.some((i) => i.serviceSnapshot.pricingMode === "PER_PERSON")).toBe(
      true,
    );
  });
  it("F1-02/04/05 three appointments reconcile selected attempts and leave unused credits without phantom Bookings", async () => {
    const t = await packageBatchFixture({ count: 3 });
    const r = await t.writer.materialize(t.scope);
    expect(r.bookings).toHaveLength(3);
    expect(r.progress.sessions).toHaveLength(3);
    for (const item of r.progress.items) {
      const scheduled = r.progress.sessions.filter((s) =>
        s.packageItemId.equals(item.packageItemId),
      );
      expect(item.remainingSessions).toBe(item.totalSessions - scheduled.length);
      expect(item.completedSessions).toBe(0);
      expect(scheduled.every((s) => s.status === "SCHEDULED")).toBe(true);
    }
    expect(r.progress.items.reduce((sum, i) => sum + i.remainingSessions, 0)).toBe(3);
    expect(await BookingModel.countDocuments({})).toBe(3);
  });
  it("F1-06 equal UTC starts select lower retained Booking hex, independent of Staff lock order", async () => {
    const t = await packageBatchFixture({ tie: true });
    const r = await t.writer.materialize(t.scope);
    const ids = t.quote.payload.appointments.map((a) => a.bookingId.toHexString()).sort();
    expect(r.progress.originBookingId.toHexString()).toBe(ids[0]);
    expect(r.preparation.originBookingId.equals(t.quote.payload.originBookingId)).toBe(true);
  });
  it("F1-07 reversed accepted selection order preserves retained identity and permanent origin", async () => {
    const t = await packageBatchFixture({ reverse: true });
    const r = await t.writer.materialize(t.scope);
    expect(r.preparation.members.map((m) => m.bookingId.toHexString())).toEqual([
      t.f.id(50).toHexString(),
      t.f.id(53).toHexString(),
    ]);
    expect(r.progress.originBookingId.equals(t.f.id(50))).toBe(true);
  });
  it("F1-08/18 owned Group replay is whole-state read-only after expiry and prospective mutation", async () => {
    const t = await packageBatchFixture({ group: true });
    const first = await t.writer.materialize(t.scope);
    await t.schedules.replace(
      t.f.providers[0]?._id ?? new Types.ObjectId(),
      t.scope.businessId,
      [],
    );
    t.advance(new Date("2031-01-01T00:00:00Z"));
    const before = await persisted();
    const replay = await t.writer.materialize(t.scope);
    expect(replay.bookings.map((b) => String(b._id))).toEqual(
      first.bookings.map((b) => String(b._id)),
    );
    expect(await persisted()).toBe(before);
  });
  it("F1-09 foreign authenticated Customer cannot enumerate or adopt the key", async () => {
    const t = await packageBatchFixture();
    await t.writer.materialize(t.scope);
    const foreign = await UserModel.create({
      normalizedEmail: "foreign@f1.test",
      passwordHash: "unused",
      role: "CUSTOMER",
      status: "ACTIVE",
      security: { passwordUpdatedAt: new Date() },
    });
    const authorization = `Bearer ${await issueTestAccessToken(t.tokens, { userId: foreign._id, role: "CUSTOMER" })}`;
    const scope = { ...t.scope, customer: await t.authority.authenticate(authorization) };
    const before = await persisted();
    await expect(t.writer.materialize(scope)).rejects.toThrow("binding unavailable or conflicting");
    await expect(readOwnedPackageBatchMaterialization(scope)).rejects.toThrow();
    expect(await persisted()).toBe(before);
  });
  it.each(["businessId", "businessClientId"] as const)(
    "F1-10 a different %s cannot read a successful complete set",
    async (field) => {
      const t = await packageBatchFixture();
      await t.writer.materialize(t.scope);
      const before = await persisted();
      await expect(
        readOwnedPackageBatchMaterialization({ ...t.scope, [field]: new Types.ObjectId() }),
      ).rejects.toThrow();
      expect(await persisted()).toBe(before);
    },
  );
  it("F1-11 missing synthetic sibling invalidates the entire owned reader", async () => {
    const t = await packageBatchFixture();
    const r = await t.writer.materialize(t.scope);
    const sibling = r.bookings[1];
    if (!sibling) throw new Error("Missing sibling");
    await BookingModel.collection.deleteOne({ _id: sibling._id });
    await expect(readOwnedPackageBatchMaterialization(t.scope)).rejects.toThrow();
    expect(
      await BookingCreationClaimModel.countDocuments({
        packageBatchMaterialization: { $exists: true },
      }),
    ).toBe(1);
  });
  it("F1-12 a swapped purchased item cannot stand in for an expected selection", async () => {
    const t = await packageBatchFixture();
    const r = await t.writer.materialize(t.scope);
    const sibling = r.bookings[1],
      item = r.preparation.members[0];
    if (!sibling || !item) throw new Error("Missing swap fixture");
    await BookingModel.collection.updateOne(
      { _id: sibling._id },
      { $set: { "serviceLines.0.pricingInput.packageItemId": item.packageItemId } },
    );
    await expect(readOwnedPackageBatchMaterialization(t.scope)).rejects.toThrow();
  });
  it("F1-13 exact selected employment rejects even while another assigned provider remains eligible", async () => {
    const t = await packageBatchFixture();
    const selected = t.quote.payload.appointments[0];
    if (!selected) throw new Error("Missing selection");
    await new StaffRepository().updateActiveById(t.scope.businessId, selected.staffMembershipId, {
      employmentActive: false,
    });
    await expect(t.writer.materialize(t.scope)).rejects.toThrow();
    await noNewMaterialization();
  });
  it("F1-14 mutation-first shift removal rejects the retained stale offer", async () => {
    const t = await packageBatchFixture();
    await t.schedules.replace(
      t.quote.payload.appointments[1]?.staffMembershipId ?? new Types.ObjectId(),
      t.scope.businessId,
      [],
    );
    await expect(t.writer.materialize(t.scope)).rejects.toThrow();
    await noNewMaterialization();
  });
  it("F1-15 admission-first holds C1 while the real prospective schedule writer waits", async () => {
    const t = await packageBatchFixture();
    const acquired = gate(),
      release = gate();
    const original = scheduling.acquireSchedulingAdmission;
    vi.spyOn(scheduling, "acquireSchedulingAdmission").mockImplementationOnce(async (...args) => {
      const b = await original(...args);
      acquired.open();
      await release.wait;
      return b;
    });
    const pending = t.writer.materialize(t.scope);
    await acquired.wait;
    const mutation = t.schedules.replace(
      t.quote.payload.appointments[1]?.staffMembershipId ?? new Types.ObjectId(),
      t.scope.businessId,
      [],
    );
    release.open();
    const [r] = await Promise.all([pending, mutation]);
    expect(r.bookings).toHaveLength(2);
    expect(await BookingModel.countDocuments({})).toBe(2);
  });
  it("F1-16 joins the actual Group target, distinct from the immutable proposed ID", async () => {
    const t = await packageBatchFixture({ group: true });
    const shared = await existingGroup(t, 1);
    const r = await t.writer.materialize(t.scope);
    const initial = r.proof.members.find((m) =>
      m.bookingId.equals(t.quote.payload.appointments.find((a) => a.group)?.bookingId),
    );
    expect(initial?.reservationId.equals(shared.reservationId)).toBe(true);
    if (!initial) throw new Error("Missing applied member");
    const operation = await BookingSlotReservationClaimModel.findOne({
      idempotencyKey: initial.operationKey,
    }).orFail();
    expect(operation.effect?.role).toBe("JOINER");
    expect(operation.reservationId.equals(shared.reservationId)).toBe(false);
    expect(operation.partySize).toBe(1);
  });
  it("F1-17 Group full aborts every new sibling while preserving the existing party", async () => {
    const t = await packageBatchFixture({ group: true });
    await existingGroup(t, 3);
    await expect(t.writer.materialize(t.scope)).rejects.toThrow();
    expect(await BookingModel.countDocuments({})).toBe(0);
    expect(await PackageProgressV2Model.countDocuments({})).toBe(0);
    expect(await BookingSlotReservationClaimModel.countDocuments({})).toBe(1);
    const day = await BookingSlotReservationModel.findOne({}).orFail();
    expect(day.intervals[0]?.capacityUsed).toBe(3);
  });
  it("F1-19 every retained initial operation freezes UTC, zone, party and batch/selection", async () => {
    const t = await packageBatchFixture({ group: true });
    const r = await t.writer.materialize(t.scope);
    for (const m of r.preparation.members) {
      const operation = await BookingSlotReservationClaimModel.findOne({
        idempotencyKey: `bookly:package-initial:v1:${t.scope.businessId}:${m.bookingId}`,
      }).orFail();
      expect(operation.partySize).toBe(1);
      expect(operation.originalIntent?.startAt).toEqual(m.startAt);
      expect(operation.originalIntent?.endAt).toEqual(m.endAt);
      expect(operation.originalIntent?.timezone).toBe("UTC");
      expect(operation.originalIntent?.capacityMax).toBe(m.group?.capacityMax ?? 1);
      expect(operation.originalIntent?.packageOperation?.batchId).toBe(
        r.preparation.batchId.toHexString(),
      );
      expect(operation.originalIntent?.packageOperation?.selectionId).toBe(
        m.selectionId.toHexString(),
      );
    }
  });
  it("F1-20 incomplete future travel entitlement rejects before any materialization", async () => {
    const t = await packageBatchFixture({ travel: true });
    await expect(t.writer.materialize(t.scope)).rejects.toThrow();
    await noNewMaterialization();
    expect(
      await BookingCreationClaimModel.countDocuments({
        packageBatchPreparation: { $exists: true },
      }),
    ).toBe(0);
  });
  it("F1-21 Service MANUAL outside Business hours still admits within Staff shift", async () => {
    const t = await packageBatchFixture({ manual: true });
    const r = await t.writer.materialize(t.scope);
    expect(r.bookings[0]?.schedule.startAt.getUTCHours()).toBe(19);
    expect(r.bookings).toHaveLength(2);
  });
  it("F1-22 a changed Business zone rejects rather than rebasing the retained UTC slots", async () => {
    const t = await packageBatchFixture();
    await new BusinessRepository().updateOwnedById(t.f.business.ownerUserId, t.scope.businessId, {
      timezone: "Asia/Dhaka",
    });
    await expect(t.writer.materialize(t.scope)).rejects.toThrow();
    await noNewMaterialization();
  });
  it("F1-23 origin owns bundle base while included siblings carry zero base/upfront and no money authority", async () => {
    const t = await packageBatchFixture();
    const r = await t.writer.materialize(t.scope);
    for (const b of r.bookings) {
      expect(b.financials.servicesSubtotalCents).toBe(
        b._id.equals(r.progress.originBookingId) ? 20000 : 0,
      );
      expect(b.financials.depositCents).toBe(0);
      expect(b.financials.platformFeeCents).toBe(0);
      expect(b.financialContract).toBeUndefined();
    }
  });
  it.each([6, 12, "FOREVER"] as const)(
    "F1-24 preserves synthetic %s validity without an activation issuer",
    async (months) => {
      const t = await packageBatchFixture(
        months === "FOREVER" ? { mode: "FOREVER" } : { mode: "FINITE", months },
      );
      const r = await t.writer.materialize(t.scope);
      expect(r.progress.creditAccountingVersion).toBe(2);
      const validity = r.progress.purchasedContract?.validity;
      expect(validity?.mode).toBe(months === "FOREVER" ? "FOREVER" : "FINITE");
      expect(validity?.purchasedAt).toEqual(r.preparation.materializedAt);
      if (validity?.mode === "FINITE") expect(validity.months).toBe(months);
      expect(r.commercialCompletion).toBe("NOT_ESTABLISHED");
    },
  );
  it.each([
    "reservation1",
    "reservation2",
    "booking1",
    "booking2",
    "progress",
    "beforeProof",
    "afterProof",
  ] as const)(
    "F1-25..31 parent abort at %s removes every new write and preserves preparation",
    async (point) => {
      const t = await packageBatchFixture({ group: true });
      const business = await BusinessModel.findById(t.scope.businessId).orFail();
      const clientVersion = (
        await BusinessClientModel.findById(t.scope.businessClientId).orFail()
      ).get("__v");
      if (point.startsWith("reservation")) {
        const original = t.reservations.reserveOrJoin.bind(t.reservations);
        let calls = 0;
        vi.spyOn(t.reservations, "reserveOrJoin").mockImplementation(async (...args) => {
          const result = await original(...args);
          if (++calls === (point === "reservation1" ? 1 : 2)) throw new Error(point);
          return result;
        });
      } else if (point.startsWith("booking")) {
        const original = BookingRepository.prototype.create;
        let calls = 0;
        vi.spyOn(BookingRepository.prototype, "create").mockImplementation(async function (
          this: BookingRepository,
          ...args
        ) {
          const result = await original.apply(this, args);
          if (++calls === (point === "booking1" ? 1 : 2)) throw new Error(point);
          return result;
        });
      } else if (point === "progress") {
        const original = PackageProgressV2Repository.prototype.create;
        vi.spyOn(PackageProgressV2Repository.prototype, "create").mockImplementation(
          async function (this: PackageProgressV2Repository, ...args) {
            await original.apply(this, args);
            throw new Error(point);
          },
        );
      } else {
        const original = claims.commitInternalPackageBatch;
        vi.spyOn(claims, "commitInternalPackageBatch").mockImplementation(async (...args) => {
          if (point === "afterProof") await original(...args);
          throw new Error(point);
        });
      }
      await expect(t.writer.materialize(t.scope)).rejects.toThrow(point);
      await noNewMaterialization();
      const retained = await BookingCreationClaimModel.findOne({
        idempotencyKey: t.scope.idempotencyKey,
      }).orFail();
      expect(
        retained.packageBatchPreparation?.members.map((m) => String(m.bookingId)).sort(),
      ).toEqual(t.quote.payload.appointments.map((a) => String(a.bookingId)).sort());
      expect(retained.packageBatchControl?.phase).toBe("PREPARED");
      expect(
        (await BusinessModel.findById(t.scope.businessId).orFail()).packageEligibilityVersion,
      ).toBe(business.packageEligibilityVersion);
      expect(
        (await BusinessClientModel.findById(t.scope.businessClientId).orFail()).get("__v"),
      ).toBe(clientVersion);
    },
  );
  it("F1-32 a concurrent same-key contender remains bounded, then resolves one canonical winner", async () => {
    const t = await packageBatchFixture({ group: true });
    const entered = gate(),
      release = gate();
    const original = t.reservations.reserveOrJoin.bind(t.reservations);
    vi.spyOn(t.reservations, "reserveOrJoin").mockImplementationOnce(async (...args) => {
      entered.open();
      await release.wait;
      return original(...args);
    });
    const first = t.writer.materialize(t.scope);
    await entered.wait;
    try {
      await expect(t.writer.materialize(t.scope)).rejects.toMatchObject({ statusCode: 503 });
    } finally {
      release.open();
    }
    const winner = await first;
    const before = await persisted();
    expect((await t.writer.materialize(t.scope)).preparation).toEqual(winner.preparation);
    expect(await persisted()).toBe(before);
    expect(await BookingModel.countDocuments({})).toBe(2);
  });
  it("F1-33 different keys racing for the same exclusive slot cannot leave a partial losing batch", async () => {
    const t = await packageBatchFixture();
    const next = await t.another();
    const outcomes = await Promise.allSettled([
      t.writer.materialize(t.scope),
      t.writer.materialize(next.scope),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await BookingModel.countDocuments({})).toBe(2);
    expect(await PackageProgressV2Model.countDocuments({})).toBe(1);
    expect(await BookingSlotReservationClaimModel.countDocuments({})).toBe(2);
  });
  it("F1-34 two batches competing for the final Group seat admit one complete set", async () => {
    const t = await packageBatchFixture({ group: true });
    const next = await t.another(false, true);
    await existingGroup(t, 2);
    const outcomes = await Promise.allSettled([
      t.writer.materialize(t.scope),
      t.writer.materialize(next.scope),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await BookingModel.countDocuments({})).toBe(2);
    expect(await PackageProgressV2Model.countDocuments({})).toBe(1);
    const days = await BookingSlotReservationModel.find({}).lean();
    expect(days.flatMap((d) => d.intervals).find((i) => i.capacityMax === 3)?.capacityUsed).toBe(3);
    expect(await BookingSlotReservationClaimModel.countDocuments({})).toBe(3);
  });
  it("F1-35 actual112 invalidates a stale callback snapshot and driver retry retains the logical IDs", async () => {
    const t = await packageBatchFixture();
    const snapshot = gate(),
      resume = gate();
    const errors: number[] = [];
    let attempts = 0;
    const original = scheduling.acquireSchedulingAdmission;
    vi.spyOn(scheduling, "acquireSchedulingAdmission").mockImplementation(async (...args) => {
      if (++attempts === 1) {
        await BusinessModel.findById(t.scope.businessId).session(args[1]);
        snapshot.open();
        await resume.wait;
      }
      try {
        return await original(...args);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "number"
        ) {
          errors.push(error.code);
          observedServerCodes.push(error.code);
        }
        throw error;
      }
    });
    const pending = t.writer.materialize(t.scope);
    await snapshot.wait;
    try {
      await t.schedules.replace(t.f.providers[0]?._id ?? new Types.ObjectId(), t.scope.businessId, [
        { dayOfWeek: "TUESDAY", intervals: [{ startTime: "09:00", endTime: "17:00" }] },
      ]);
    } finally {
      resume.open();
    }
    const result = await pending;
    expect(errors).toContain(112);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(result.bookings.map((b) => String(b._id)).sort()).toEqual(
      t.quote.payload.appointments.map((a) => String(a.bookingId)).sort(),
    );
    expect(await BookingSlotReservationClaimModel.countDocuments({})).toBe(2);
  });
  it("F1-36 a real retained-ID11000 aborts new reservations and never reports origin-only success", async () => {
    const t = await packageBatchFixture();
    const prior = await t.writer.materialize(t.scope);
    const next = await t.another(true);
    const sample = prior.bookings[0];
    const collision = next.quote.payload.appointments[0];
    if (!sample || !collision) throw new Error("Missing collision fixture");
    await new BookingModel({
      ...sample,
      _id: collision.bookingId,
      reference: "BK-COLLIDE2",
    }).save();
    await expect(
      t.writer.materialize(next.scope).catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "number"
        )
          observedServerCodes.push(error.code);
        throw error;
      }),
    ).rejects.toMatchObject({ code: 11000 });
    expect(await BookingModel.countDocuments({})).toBe(3);
    expect(await PackageProgressV2Model.countDocuments({})).toBe(1);
    expect(await BookingSlotReservationClaimModel.countDocuments({})).toBe(2);
    expect(await readOwnedPackageBatchMaterialization(next.scope)).toBeNull();
  });
  it("F1-37 a real commit followed by controlled application-return loss resolves the complete proof", async () => {
    const t = await packageBatchFixture();
    const original = mongoose.mongo.ClientSession.prototype.withTransaction;
    vi.spyOn(mongoose.mongo.ClientSession.prototype, "withTransaction").mockImplementationOnce(
      async function (this: ClientSession, fn, options) {
        await original.call(this, fn, options);
        throw new Error("lost application return after commit");
      },
    );
    const r = await t.writer.materialize(t.scope);
    expect(r.bookings).toHaveLength(2);
    expect(await PackageProgressV2Model.countDocuments({})).toBe(1);
  });
  it("F1-38 unknown outcome with absent winner stays pinned and never restarts from absence", async () => {
    const t = await packageBatchFixture();
    const original = mongoose.mongo.ClientSession.prototype.withTransaction;
    vi.spyOn(mongoose.mongo.ClientSession.prototype, "withTransaction").mockImplementationOnce(
      async function (this: ClientSession, fn, options) {
        await original
          .call(
            this,
            async (session) => {
              await fn(session);
              throw new Error("controlled callback rollback");
            },
            options,
          )
          .catch(() => {
            throw Object.assign(new Error("unknown outcome"), {
              errorLabels: ["UnknownTransactionCommitResult"],
            });
          });
        throw new Error("unreachable");
      },
    );
    await expect(t.writer.materialize(t.scope)).rejects.toMatchObject({ statusCode: 503 });
    const row = await BookingCreationClaimModel.findOne({
      idempotencyKey: t.scope.idempotencyKey,
    }).orFail();
    expect(row.packageBatchControl?.phase).toBe("PERSISTING");
    const before = await persisted();
    t.advance(new Date("2032-01-01T00:00:00Z"));
    await expect(t.writer.materialize(t.scope)).rejects.toMatchObject({ statusCode: 503 });
    expect(await persisted()).toBe(before);
    await noNewMaterialization();
  });
  it("F1-39 preparation is set-once and a wrong control token cannot release or append", async () => {
    const t = await packageBatchFixture();
    const p = await prepareInternalPackageBatch(t.scope, new Date("2030-08-19T08:01:00Z"));
    expect(await prepareInternalPackageBatch(t.scope, new Date("2030-08-19T08:02:00Z"))).toEqual(p);
    const token = await claims.claimInternalPackageBatch(t.scope, p);
    expect(token).not.toBeNull();
    expect(
      await claims.releaseKnownAbortedPackageBatch(t.scope, "00000000-0000-4000-8000-000000000000"),
    ).toBe(false);
    const session = await mongoose.startSession();
    try {
      await expect(
        session.withTransaction(() =>
          claims.commitInternalPackageBatch(
            t.scope,
            "00000000-0000-4000-8000-000000000000",
            {},
            session,
          ),
        ),
      ).rejects.toThrow();
    } finally {
      await session.endSession();
    }
    expect(
      (await BookingCreationClaimModel.findById(p.claimId).orFail()).packageBatchControl,
    ).toMatchObject({ phase: "PERSISTING", token });
    await noNewMaterialization();
  });
  it("original full membership remains readable after a real Customer Group reschedule releases the old effect", async () => {
    const t = await packageBatchFixture({ group: true });
    const initial = await t.writer.materialize(t.scope);
    const member = initial.bookings[0];
    if (!member) throw new Error("Missing initial Booking");
    const moved = await t.lifecycle.rescheduleByCustomer(
      t.f.context.customerUserId.toHexString(),
      member._id.toHexString(),
      "2030-08-21T09:00:00Z",
    );
    expect(moved.rescheduleHistory).toHaveLength(1);
    expect(moved.serviceLines[0]?.reservationId.equals(member.serviceLines[0]?.reservationId)).toBe(
      false,
    );
    const original = initial.proof.members.find((m) => m.bookingId.equals(member._id));
    const operation = await BookingSlotReservationClaimModel.findOne({
      idempotencyKey: original?.operationKey ?? "missing",
    }).orFail();
    expect(operation.effect?.state).toBe("RELEASED");
    const before = await persisted();
    const replay = await t.writer.materialize(t.scope);
    expect(replay.preparation.originBookingId.equals(initial.preparation.originBookingId)).toBe(
      true,
    );
    expect(replay.bookings.map((b) => String(b._id))).toEqual(
      initial.bookings.map((b) => String(b._id)),
    );
    expect(replay.bookings[0]?.schedule.startAt).toEqual(moved.schedule.startAt);
    expect(await persisted()).toBe(before);
  });
  it("a foreign owned-set sibling cannot be authorized by a correctly owned Progress", async () => {
    const t = await packageBatchFixture();
    const r = await t.writer.materialize(t.scope);
    const sibling = r.bookings[1];
    if (!sibling) throw new Error("Missing sibling");
    await BookingModel.collection.updateOne(
      { _id: sibling._id },
      { $set: { "customer.customerUserId": new Types.ObjectId() } },
    );
    await expect(readOwnedPackageBatchMaterialization(t.scope)).rejects.toThrow();
  });
  it("a contradictory original actual-target proof fails closed", async () => {
    const t = await packageBatchFixture();
    const r = await t.writer.materialize(t.scope);
    await BookingCreationClaimModel.collection.updateOne(
      { _id: r.preparation.claimId },
      { $set: { "packageBatchMaterialization.members.0.reservationId": new Types.ObjectId() } },
    );
    await expect(readOwnedPackageBatchMaterialization(t.scope)).rejects.toThrow();
  });
  it("policy creation first joins the coordinator and denies a quote accepting no configured policy", async () => {
    const t = await packageBatchFixture();
    await new BusinessCancellationPolicyRepository().replace(
      t.scope.businessId,
      cancellationTiers.map((tier) => ({ tier, mode: "FREE" })),
      20,
    );
    await expect(t.writer.materialize(t.scope)).rejects.toThrow();
    await noNewMaterialization();
  });
  it("policy creation after held admission applies prospectively and cannot overtake materialization", async () => {
    const t = await packageBatchFixture();
    const held = gate(),
      release = gate();
    const original = scheduling.acquireSchedulingAdmission;
    vi.spyOn(scheduling, "acquireSchedulingAdmission").mockImplementationOnce(async (...args) => {
      const b = await original(...args);
      held.open();
      await release.wait;
      return b;
    });
    const pending = t.writer.materialize(t.scope);
    await held.wait;
    const mutation = new BusinessCancellationPolicyRepository().replace(
      t.scope.businessId,
      cancellationTiers.map((tier) => ({ tier, mode: "FREE" })),
      20,
    );
    release.open();
    const [result] = await Promise.all([pending, mutation]);
    expect(result.bookings).toHaveLength(2);
    expect(await readOwnedPackageBatchMaterialization(t.scope)).not.toBeNull();
  });
  it("committed proof is preserved when bounded recovery reads are temporarily unavailable", async () => {
    const t = await packageBatchFixture();
    let unavailable = false;
    const read = claims.readOwnedPackageBatchMaterialization;
    vi.spyOn(claims, "readOwnedPackageBatchMaterialization").mockImplementation(async (...args) => {
      if (unavailable) throw new Error("controlled read unavailable");
      return read(...args);
    });
    const transaction = mongoose.mongo.ClientSession.prototype.withTransaction;
    vi.spyOn(mongoose.mongo.ClientSession.prototype, "withTransaction").mockImplementationOnce(
      async function (this: ClientSession, fn, options) {
        await transaction.call(this, fn, options);
        unavailable = true;
        throw new Error("controlled lost application return");
      },
    );
    await expect(t.writer.materialize(t.scope)).rejects.toMatchObject({ statusCode: 503 });
    expect(await BookingModel.countDocuments({})).toBe(2);
    expect(await PackageProgressV2Model.countDocuments({})).toBe(1);
    const before = await persisted();
    await expect(t.writer.materialize(t.scope)).rejects.toMatchObject({ statusCode: 503 });
    unavailable = false;
    expect((await t.writer.materialize(t.scope)).bookings).toHaveLength(2);
    expect(await persisted()).toBe(before);
  });
  it("joined-session core commits only when its external parent commits", async () => {
    const t = await packageBatchFixture();
    const p = await prepareInternalPackageBatch(t.scope, new Date("2030-08-19T08:01:00Z"));
    const token = await claims.claimInternalPackageBatch(t.scope, p);
    if (!token) throw new Error("Missing token");
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await t.writer.materializeInSession(t.scope, token, session);
        expect(await BookingModel.countDocuments({}).session(session)).toBe(2);
        expect(await BookingModel.countDocuments({})).toBe(0);
      });
    } finally {
      await session.endSession();
    }
    expect((await readOwnedPackageBatchMaterialization(t.scope))?.bookings).toHaveLength(2);
  });
  it("an ordinary claim under the same namespace cannot be promoted to a batch", async () => {
    const t = await packageBatchFixture();
    await BookingCreationClaimModel.create({
      idempotencyKey: "ordinary-f1-collision",
      businessId: t.scope.businessId,
      actorUserId: t.f.context.customerUserId,
      bookingId: new Types.ObjectId(),
    });
    const before = await persisted();
    await expect(
      t.writer.materialize({ ...t.scope, idempotencyKey: "ordinary-f1-collision" }),
    ).rejects.toThrow("binding unavailable or conflicting");
    expect(await persisted()).toBe(before);
    await noNewMaterialization();
  });
  it("CRM unlink first denies initial admission without transferring canonical ownership", async () => {
    const t = await packageBatchFixture();
    await new ClientRepository().setLinkState(t.scope.businessClientId, { linkState: "UNLINKED" });
    await expect(t.writer.materialize(t.scope)).rejects.toThrow();
    await noNewMaterialization();
  });
  it("expiry observed after acquisition aborts before admission; it is not commit-clock proof", async () => {
    const t = await packageBatchFixture();
    const held = gate(),
      release = gate();
    const acquire = scheduling.acquireSchedulingAdmission;
    vi.spyOn(scheduling, "acquireSchedulingAdmission").mockImplementationOnce(async (...args) => {
      const business = await acquire(...args);
      held.open();
      await release.wait;
      return business;
    });
    const pending = t.writer.materialize(t.scope);
    await held.wait;
    t.advance(new Date("2030-08-19T08:30:00Z"));
    release.open();
    await expect(pending).rejects.toThrow();
    await noNewMaterialization();
    expect(
      (await BookingCreationClaimModel.findOne({ idempotencyKey: t.scope.idempotencyKey }).orFail())
        .packageBatchControl?.phase,
    ).toBe("PREPARED");
  });
  it("held Client identity write orders later unlink; historical membership remains nested-Customer-owned", async () => {
    const t = await packageBatchFixture();
    const held = gate(),
      release = gate();
    const reserve = t.reservations.reserveOrJoin.bind(t.reservations);
    vi.spyOn(t.reservations, "reserveOrJoin").mockImplementationOnce(async (...args) => {
      held.open();
      await release.wait;
      return reserve(...args);
    });
    const pending = t.writer.materialize(t.scope);
    await held.wait;
    const unlink = new ClientRepository().setLinkState(t.scope.businessClientId, {
      linkState: "UNLINKED",
    });
    release.open();
    const [result] = await Promise.all([pending, unlink]);
    expect(result.bookings).toHaveLength(2);
    expect(
      (await BusinessClientModel.findById(t.scope.businessClientId).orFail()).linkedUserId,
    ).toBeUndefined();
    expect(
      (await readOwnedPackageBatchMaterialization(t.scope))?.bookings.map((b) => String(b._id)),
    ).toEqual(result.bookings.map((b) => String(b._id)));
  });
  it.each([{ first: true }, { categoryWindow: true }])(
    "unsupported financial or global-policy authority fails closed: %o",
    async (options) => {
      const t = await packageBatchFixture(options);
      await expect(t.writer.materialize(t.scope)).rejects.toThrow();
      await noNewMaterialization();
      expect(
        await BookingCreationClaimModel.countDocuments({
          packageBatchPreparation: { $exists: true },
        }),
      ).toBe(0);
    },
  );
  it("uncommitted expired preparation cannot reuse its pinned internal timestamp to admit later", async () => {
    const t = await packageBatchFixture();
    await prepareInternalPackageBatch(t.scope, new Date("2030-08-19T08:01:00Z"));
    t.advance(new Date("2030-08-19T09:00:00Z"));
    const before = await persisted();
    await expect(t.writer.materialize(t.scope)).rejects.toThrow();
    await noNewMaterialization();
    expect(await persisted()).toBe(before);
  });
  it("joined-session outer abort rolls back core proof, Progress, Bookings and effects together", async () => {
    const t = await packageBatchFixture({ group: true });
    const p = await prepareInternalPackageBatch(t.scope, new Date("2030-08-19T08:01:00Z"));
    const token = await claims.claimInternalPackageBatch(t.scope, p);
    if (!token) throw new Error("Missing token");
    const session = await mongoose.startSession();
    try {
      await expect(
        session.withTransaction(async () => {
          await t.writer.materializeInSession(t.scope, token, session);
          throw new Error("outer parent aborted");
        }),
      ).rejects.toThrow("outer parent aborted");
    } finally {
      await session.endSession();
    }
    await noNewMaterialization();
    expect(
      (await BookingCreationClaimModel.findById(p.claimId).orFail()).packageBatchControl?.phase,
    ).toBe("PERSISTING");
    expect(await claims.releaseKnownAbortedPackageBatch(t.scope, token)).toBe(true);
  });
  it.each(["packageBatchPreparation", "packageBatchControl", "packageBatchMaterialization"])(
    "generic patch/save cannot forge %s",
    async (field) => {
      const t = await packageBatchFixture();
      await expect(
        BookingCreationClaimModel.updateOne(
          { idempotencyKey: t.scope.idempotencyKey },
          { $set: { [field]: { version: 1 } } },
        ),
      ).rejects.toThrow("immutable");
      const row = await BookingCreationClaimModel.findOne({
        idempotencyKey: t.scope.idempotencyKey,
      }).orFail();
      row.set(field, { version: 1 });
      await expect(row.save({ validateBeforeSave: false })).rejects.toThrow("immutable");
      await noNewMaterialization();
    },
  );
});
