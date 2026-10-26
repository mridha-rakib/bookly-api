import { isDeepStrictEqual } from "node:util";
import type { ClientSession, Types } from "mongoose";
import { BookingModel } from "../booking/booking.model.js";
import { BusinessModel } from "../business/business.model.js";
import { normalizeBusinessVisitType } from "../business/business.types.js";
import { BusinessClientModel } from "../client/client.model.js";
import { PackageModel } from "../packages/package.model.js";
import { resolvePackageServiceEntitlement } from "../packages/package-service-entitlement.js";
import { copyPackageDefinitionContractTerms } from "../packages/package-session-penalty-policy.js";
import { ServiceModel } from "../services/service.model.js";
import { StaffMembershipModel } from "../staff/staff.model.js";
import {
  acquirePackageEligibilityFence,
  packageEligibilityError,
  requirePackageTransaction,
} from "./package-eligibility.js";
import { computePackageBalanceSettlement } from "./package-progress.rules.js";
import {
  commitProspectivePackageTransition,
  PackageProgressV2Model,
} from "./package-progress-v2.model.js";
import { packageProgressV2InputSchema } from "./package-progress-v2.rules.js";
import type {
  CreatePackageProgressV2Input,
  PackageItemScope,
  PackageProgressV2Document,
  ProspectivePackageProgressV2Document,
} from "./package-progress-v2.types.js";

export class PackageProgressV2Repository {
  /** Internal server dependency, never an HTTP/DTO timestamp. Tests may inject a clock;
   * every retried transaction samples it after acquiring the Business fence. */
  public constructor(private readonly clock: () => Date = () => new Date()) {}
  /** Internal only. P3 must insert the origin Booking/reservation and first claim in this
   * same transaction. No HTTP route or legacy creation path calls this method. */
  public async create(
    input: CreatePackageProgressV2Input,
    session: ClientSession,
  ): Promise<PackageProgressV2Document> {
    const valid = packageProgressV2InputSchema.parse(input);
    await acquirePackageEligibilityFence(valid.businessId, session);
    const business = await BusinessModel.findById(valid.businessId).session(session);
    const definition = await PackageModel.findOne({
      _id: valid.packageId,
      businessId: valid.businessId,
      status: "ACTIVE",
    }).session(session);
    const client = await BusinessClientModel.exists({
      _id: valid.businessClientId,
      businessId: valid.businessId,
      linkedUserId: valid.customerUserId,
    }).session(session);
    if (
      !business ||
      !definition ||
      !client ||
      !["APPROVED", "WARNING"].includes(business.status) ||
      normalizeBusinessVisitType(business.visitType) !== valid.purchaseSnapshot.fulfilmentMode
    )
      throw packageEligibilityError("PACKAGE_PURCHASE_LINK_INVALID", 404);
    if (
      definition.revision !== valid.purchaseSnapshot.packageRevision ||
      definition.bundlePriceCents !== valid.purchaseSnapshot.bundlePriceCents ||
      definition.items.length !== valid.items.length ||
      !valid.sessions.some(
        (attempt) =>
          attempt.bookingId.equals(valid.originBookingId) && attempt.status === "SCHEDULED",
      )
    )
      throw packageEligibilityError("PACKAGE_ACCEPTED_OFFER_MISMATCH");
    if (valid.creditAccountingVersion === 2) {
      if (
        !definition.contractTerms ||
        !isDeepStrictEqual(
          copyPackageDefinitionContractTerms(definition.contractTerms),
          valid.purchasedContract.definition.contractTerms,
        ) ||
        valid.expiryReconciledAt ||
        valid.items.some((item) => item.expiredSessions !== 0 || item.expiryEvent) ||
        valid.sessions.some((attempt) => attempt.status !== "SCHEDULED")
      )
        throw packageEligibilityError("PACKAGE_ACCEPTED_OFFER_MISMATCH");
    }
    // Identity/ownership and current eligibility are rechecked under the shared fence. Terms
    // are accepted snapshots; later catalog edits never update this document.
    for (const item of valid.items) {
      const service = await ServiceModel.findOne({
        _id: item.serviceId,
        businessId: valid.businessId,
        status: "ACTIVE",
        isPackageDeal: false,
        pricingMode: item.serviceSnapshot.pricingMode,
      }).session(session);
      const row = definition.items.find(
        (row) => row.itemId.equals(item.definitionItemId) && row.serviceId.equals(item.serviceId),
      );
      const entitlement = service && resolvePackageServiceEntitlement(service);
      if (
        !service ||
        !row ||
        !entitlement ||
        !isDeepStrictEqual(
          entitlement.group,
          item.serviceSnapshot.pricingMode === "PER_PERSON"
            ? item.serviceSnapshot.group
            : undefined,
        )
      )
        throw packageEligibilityError("PACKAGE_PURCHASE_LINK_INVALID", 404);
      if (
        row.includedSessions !== item.totalSessions ||
        row.referenceUnitPriceCents !== item.referenceUnitPriceCents
      )
        throw packageEligibilityError("PACKAGE_ACCEPTED_OFFER_MISMATCH");
      if (
        valid.creditAccountingVersion === 2 &&
        row.penaltyBasisCents !==
          valid.items.find((candidate) => candidate.packageItemId.equals(item.packageItemId))
            ?.penaltyBasisCents
      )
        throw packageEligibilityError("PACKAGE_ACCEPTED_OFFER_MISMATCH");
      const provider = await StaffMembershipModel.exists({
        businessId: valid.businessId,
        _id: { $in: service.assignedStaffMembershipIds },
        employmentActive: true,
        removedAt: { $exists: false },
        role: { $in: ["STAFF", "SUPERVISOR"] },
      }).session(session);
      if (!provider) throw packageEligibilityError("PACKAGE_NOT_SELLABLE");
    }
    return new PackageProgressV2Model(valid).save({ session });
  }
  public async findOwned(
    id: Types.ObjectId,
    businessId: Types.ObjectId,
    customerUserId: Types.ObjectId,
    session: ClientSession,
  ) {
    requirePackageTransaction(session);
    return PackageProgressV2Model.findOne({
      _id: id,
      schemaVersion: 2,
      businessId,
      customerUserId,
    }).session(session);
  }
  public async claim(
    scope: PackageItemScope,
    bookingId: Types.ObjectId,
    session: ClientSession,
  ): Promise<{ isNew: boolean; progress: PackageProgressV2Document }> {
    await acquirePackageEligibilityFence(scope.businessId, session);
    const current = await this.requireItem(scope, session);
    if (current.creditAccountingVersion === 2) {
      const attempt = current.sessions.find((row) => row.bookingId.equals(bookingId));
      if (attempt) {
        if (
          !attempt.packageItemId.equals(scope.packageItemId) ||
          !attempt.serviceId.equals(scope.serviceId)
        )
          throw packageEligibilityError("PACKAGE_ATTEMPT_MISMATCH");
        return { isNew: false, progress: current };
      }
      const now = this.authorizationTime(current);
      if (
        current.voidedAt ||
        current.expiryReconciledAt ||
        (current.purchasedContract.validity.mode === "FINITE" &&
          now >= current.purchasedContract.validity.expiresAt)
      )
        throw packageEligibilityError("PACKAGE_CREDIT_UNAVAILABLE");
      await this.assertProspectiveEligibility(current, scope, session);
      // Revalidate at the final authorization write boundary, after dependency/settlement reads.
      if (
        current.purchasedContract.validity.mode === "FINITE" &&
        this.authorizationTime(current) >= current.purchasedContract.validity.expiresAt
      )
        throw packageEligibilityError("PACKAGE_CREDIT_UNAVAILABLE");
      const next = this.copy(current);
      const item = next.items.find((item) => item.packageItemId.equals(scope.packageItemId));
      if (!item || item.remainingSessions < 1)
        throw packageEligibilityError("PACKAGE_CREDIT_UNAVAILABLE");
      item.remainingSessions -= 1;
      next.sessions.push({
        bookingId,
        packageItemId: scope.packageItemId,
        serviceId: scope.serviceId,
        status: "SCHEDULED",
      });
      await commitProspectivePackageTransition(current, next, session);
      return { isNew: true, progress: next };
    }
    const updated = await PackageProgressV2Model.findOneAndUpdate(
      {
        ...this.root(scope),
        voidedAt: { $exists: false },
        "sessions.bookingId": { $ne: bookingId },
        items: {
          $elemMatch: {
            packageItemId: scope.packageItemId,
            serviceId: scope.serviceId,
            remainingSessions: { $gte: 1 },
          },
        },
      },
      {
        $inc: { "items.$[item].remainingSessions": -1 },
        $push: {
          sessions: {
            bookingId,
            packageItemId: scope.packageItemId,
            serviceId: scope.serviceId,
            status: "SCHEDULED",
          },
        },
      },
      {
        session,
        returnDocument: "after",
        arrayFilters: [
          { "item.packageItemId": scope.packageItemId, "item.serviceId": scope.serviceId },
        ],
      },
    );
    if (updated) return { isNew: true, progress: updated };
    const progress = await this.requireItem(scope, session);
    const attempt = progress.sessions.find((attempt) => attempt.bookingId.equals(bookingId));
    if (
      attempt?.packageItemId.equals(scope.packageItemId) &&
      attempt.serviceId.equals(scope.serviceId)
    )
      return { isNew: false, progress };
    throw packageEligibilityError(
      attempt ? "PACKAGE_ATTEMPT_MISMATCH" : "PACKAGE_CREDIT_UNAVAILABLE",
    );
  }
  public async resolve(
    scope: PackageItemScope,
    bookingId: Types.ObjectId,
    outcome: "COMPLETED" | "CANCELLED" | "FORFEITED",
    session: ClientSession,
  ): Promise<boolean> {
    await acquirePackageEligibilityFence(scope.businessId, session);
    const current = await this.requireItem(scope, session);
    if (current.creditAccountingVersion === 2)
      return (await this.resolveProspective(current, scope, bookingId, outcome, session)).isNew;
    const counter =
      outcome === "COMPLETED"
        ? { "items.$[item].completedSessions": 1 }
        : outcome === "CANCELLED"
          ? { "items.$[item].remainingSessions": 1 }
          : undefined;
    const updated = await PackageProgressV2Model.updateOne(
      {
        ...this.root(scope),
        items: { $elemMatch: { packageItemId: scope.packageItemId, serviceId: scope.serviceId } },
        sessions: {
          $elemMatch: {
            bookingId,
            packageItemId: scope.packageItemId,
            serviceId: scope.serviceId,
            status: "SCHEDULED",
          },
        },
      },
      { $set: { "sessions.$[attempt].status": outcome }, ...(counter ? { $inc: counter } : {}) },
      {
        session,
        arrayFilters: [
          {
            "attempt.bookingId": bookingId,
            "attempt.packageItemId": scope.packageItemId,
            "attempt.serviceId": scope.serviceId,
            "attempt.status": "SCHEDULED",
          },
          ...(counter
            ? [{ "item.packageItemId": scope.packageItemId, "item.serviceId": scope.serviceId }]
            : []),
        ],
      },
    );
    if (updated.modifiedCount) return true;
    const progress = await this.requireItem(scope, session);
    const attempt = progress.sessions.find(
      (attempt) =>
        attempt.bookingId.equals(bookingId) &&
        attempt.packageItemId.equals(scope.packageItemId) &&
        attempt.serviceId.equals(scope.serviceId),
    );
    if (!attempt) throw packageEligibilityError("PACKAGE_ATTEMPT_MISMATCH", 404);
    if (attempt.status !== outcome)
      throw packageEligibilityError("PACKAGE_ATTEMPT_ALREADY_RESOLVED");
    return false;
  }
  public async void(
    id: Types.ObjectId,
    businessId: Types.ObjectId,
    customerUserId: Types.ObjectId,
    session: ClientSession,
  ): Promise<boolean> {
    await acquirePackageEligibilityFence(businessId, session);
    const current = await PackageProgressV2Model.findOne({ _id: id, businessId, customerUserId })
      .session(session)
      .lean();
    if (!current) throw packageEligibilityError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    this.validate(current);
    if (current.creditAccountingVersion === 2) {
      if (current.voidedAt) return false;
      if (current.sessions.some((attempt) => attempt.status === "SCHEDULED"))
        throw packageEligibilityError("PACKAGE_PROGRESS_UNRESOLVED_APPOINTMENT");
      const next = this.copy(current);
      next.voidedAt = this.authorizationTime(current);
      await commitProspectivePackageTransition(current, next, session);
      return true;
    }
    const result = await PackageProgressV2Model.updateOne(
      {
        _id: id,
        schemaVersion: 2,
        businessId,
        customerUserId,
        voidedAt: { $exists: false },
        sessions: { $not: { $elemMatch: { status: "SCHEDULED" } } },
      },
      { $set: { voidedAt: new Date() } },
      { session },
    );
    if (result.modifiedCount) return true;
    const progress = await this.findOwned(id, businessId, customerUserId, session);
    if (!progress) throw packageEligibilityError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    if (progress.voidedAt) return false;
    throw packageEligibilityError("PACKAGE_PROGRESS_UNRESOLVED_APPOINTMENT");
  }
  /** Stored terminal evidence is returned on a replay without resampling/reclassifying time.
   * Lifecycle authorization/status and real Booking writes remain the caller's P3 duty. */
  public async resolveWithResult(
    scope: PackageItemScope,
    bookingId: Types.ObjectId,
    outcome: "COMPLETED" | "CANCELLED" | "FORFEITED",
    session: ClientSession,
  ) {
    await acquirePackageEligibilityFence(scope.businessId, session);
    const current = await this.requireItem(scope, session);
    if (current.creditAccountingVersion !== 2)
      throw packageEligibilityError("PACKAGE_ACCOUNTING_VERSION_REQUIRED");
    return this.resolveProspective(current, scope, bookingId, outcome, session);
  }
  /** One purchase, all items, one transaction; no scan/worker/provider operation. */
  public async reconcileExpiry(
    id: Types.ObjectId,
    businessId: Types.ObjectId,
    customerUserId: Types.ObjectId,
    session: ClientSession,
  ) {
    await acquirePackageEligibilityFence(businessId, session);
    const current = await PackageProgressV2Model.findOne({ _id: id, businessId, customerUserId })
      .session(session)
      .lean();
    if (!current) throw packageEligibilityError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    this.validate(current);
    if (current.creditAccountingVersion !== 2)
      throw packageEligibilityError("PACKAGE_ACCOUNTING_VERSION_REQUIRED");
    if (current.purchasedContract.validity.mode !== "FINITE")
      throw packageEligibilityError("PACKAGE_NO_TIME_EXPIRY");
    if (current.expiryReconciledAt)
      return { isNew: false, events: current.items.map((item) => item.expiryEvent) };
    const now = this.authorizationTime(current);
    const cutoff = current.purchasedContract.validity.expiresAt;
    if (now < cutoff) throw packageEligibilityError("PACKAGE_NOT_EXPIRED");
    const next = this.copy(current);
    next.expiryReconciledAt = now;
    for (const item of next.items) {
      item.expiryEvent = {
        eventKey: `expiry:${id}:${item.packageItemId}`,
        packageProgressId: id,
        packageItemId: item.packageItemId,
        cutoff,
        quantity: item.remainingSessions,
        reason: "VALIDITY_EXPIRED",
        processedAt: now,
      };
      item.expiredSessions += item.remainingSessions;
      item.remainingSessions = 0;
    }
    await commitProspectivePackageTransition(current, next, session);
    return { isNew: true, events: next.items.map((item) => item.expiryEvent) };
  }
  private async resolveProspective(
    current: ProspectivePackageProgressV2Document,
    scope: PackageItemScope,
    bookingId: Types.ObjectId,
    outcome: "COMPLETED" | "CANCELLED" | "FORFEITED",
    session: ClientSession,
  ) {
    const index = current.sessions.findIndex(
      (attempt) =>
        attempt.bookingId.equals(bookingId) &&
        attempt.packageItemId.equals(scope.packageItemId) &&
        attempt.serviceId.equals(scope.serviceId),
    );
    const attempt = current.sessions[index];
    if (!attempt) throw packageEligibilityError("PACKAGE_ATTEMPT_MISMATCH", 404);
    if (attempt.status !== "SCHEDULED") {
      if (attempt.status !== outcome || !attempt.resolution)
        throw packageEligibilityError("PACKAGE_ATTEMPT_ALREADY_RESOLVED");
      return { isNew: false, ...attempt.resolution };
    }
    const now = this.authorizationTime(current);
    const next = this.copy(current);
    const target = next.sessions[index];
    const item = next.items.find((item) => item.packageItemId.equals(scope.packageItemId));
    if (!target || !item) throw packageEligibilityError("PACKAGE_ATTEMPT_MISMATCH");
    const expired =
      !!current.expiryReconciledAt ||
      (current.purchasedContract.validity.mode === "FINITE" &&
        now >= current.purchasedContract.validity.expiresAt);
    const resolution = {
      eventKey: `resolution:${bookingId}`,
      resolvedAt: now,
      outcome,
      ...(outcome === "CANCELLED"
        ? { restorationDisposition: expired ? ("EXPIRED" as const) : ("AVAILABLE" as const) }
        : {}),
    };
    target.status = outcome;
    target.resolution = resolution;
    if (outcome === "COMPLETED") item.completedSessions += 1;
    if (outcome === "CANCELLED") {
      if (expired) item.expiredSessions += 1;
      else item.remainingSessions += 1;
    }
    await commitProspectivePackageTransition(current, next, session);
    return { isNew: true, ...resolution };
  }
  private authorizationTime(progress: ProspectivePackageProgressV2Document): Date {
    const now = new Date(this.clock().getTime());
    if (
      !Number.isFinite(now.getTime()) ||
      now < progress.purchasedContract.validity.purchasedAt ||
      (progress.expiryReconciledAt && now < progress.expiryReconciledAt)
    )
      throw packageEligibilityError("PACKAGE_AUTHORIZATION_CLOCK_INVALID");
    return now;
  }
  private copy(
    progress: ProspectivePackageProgressV2Document,
  ): ProspectivePackageProgressV2Document {
    return {
      ...progress,
      items: progress.items.map((item) => ({ ...item })),
      sessions: progress.sessions.map((attempt) => ({ ...attempt })),
    };
  }
  private validate(progress: PackageProgressV2Document) {
    const { createdAt: _created, updatedAt: _updated, ...input } = progress;
    packageProgressV2InputSchema.parse(input);
  }
  private async assertProspectiveEligibility(
    progress: ProspectivePackageProgressV2Document,
    scope: PackageItemScope,
    session: ClientSession,
  ) {
    const business = await BusinessModel.findOne({
      _id: scope.businessId,
      status: { $in: ["APPROVED", "WARNING"] },
    }).session(session);
    const client = await BusinessClientModel.exists({
      _id: progress.businessClientId,
      businessId: scope.businessId,
      linkedUserId: scope.customerUserId,
    }).session(session);
    const purchasedItem = progress.items.find((item) =>
      item.packageItemId.equals(scope.packageItemId),
    );
    if (!purchasedItem) throw packageEligibilityError("PACKAGE_NOT_SELLABLE");
    const service = await ServiceModel.findOne({
      _id: scope.serviceId,
      businessId: scope.businessId,
      isPackageDeal: false,
      pricingMode: purchasedItem.serviceSnapshot.pricingMode,
      status: { $in: ["ACTIVE", "INACTIVE"] },
    }).session(session);
    const entitlement = service && resolvePackageServiceEntitlement(service);
    if (!entitlement || !isDeepStrictEqual(entitlement.group, purchasedItem?.serviceSnapshot.group))
      throw packageEligibilityError("PACKAGE_NOT_SELLABLE");
    const provider =
      service &&
      (await StaffMembershipModel.exists({
        businessId: scope.businessId,
        _id: { $in: service.assignedStaffMembershipIds },
        employmentActive: true,
        removedAt: { $exists: false },
        role: { $in: ["STAFF", "SUPERVISOR"] },
      }).session(session));
    if (
      !business ||
      !client ||
      !service ||
      !provider ||
      normalizeBusinessVisitType(business.visitType) !== progress.purchaseSnapshot.fulfilmentMode
    )
      throw packageEligibilityError("PACKAGE_NOT_SELLABLE");
    const origin = await BookingModel.findOne({
      _id: progress.originBookingId,
      businessId: scope.businessId,
      "customer.customerUserId": scope.customerUserId,
    }).session(session);
    if (!origin || !computePackageBalanceSettlement(origin).balanceSettled)
      throw packageEligibilityError("PACKAGE_BALANCE_UNSETTLED");
  }
  private root(scope: PackageItemScope) {
    return {
      _id: scope.packageProgressId,
      businessId: scope.businessId,
      customerUserId: scope.customerUserId,
      schemaVersion: 2 as const,
    };
  }
  private async requireItem(scope: PackageItemScope, session: ClientSession) {
    const progress = await PackageProgressV2Model.findOne(this.root(scope)).session(session).lean();
    if (
      !progress?.items.some(
        (item) =>
          item.packageItemId.equals(scope.packageItemId) && item.serviceId.equals(scope.serviceId),
      )
    )
      throw packageEligibilityError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    this.validate(progress);
    return progress;
  }
}
