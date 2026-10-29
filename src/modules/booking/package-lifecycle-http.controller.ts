import type { Request, Response } from "express";
import { Error as MongooseError, mongo, Types } from "mongoose";
import { z } from "zod";
import { AppError } from "../../common/errors/app-error.js";
import { sendSuccess } from "../../common/http/responses.js";
import { AddonModel } from "../addons/addon.model.js";
import { AddonServiceAssignmentModel } from "../addons/addon-service-assignment.model.js";
import { BusinessClientModel } from "../client/client.model.js";
import { PackageProgressV2Model } from "../package-progress/package-progress-v2.model.js";
import { readPackagePurchaseCompletion } from "../package-progress/package-view.service.js";
import { verifyPackageBatchActivation } from "./package-batch-authority.js";
import { PackageBatchUnresolvedError } from "./package-batch-contract.js";
import { PackageCheckoutConflictError } from "./package-checkout.errors.js";
import { readPackageCheckoutCustomer } from "./package-checkout-customer-authority.js";
import { PackageLifecyclePaymentPendingError } from "./package-lifecycle.service.js";
import type { PackageLifecycleHttpServices } from "./package-lifecycle-http.factory.js";
import {
  lifecycleHttpActions,
  lifecycleHttpSchemas,
  lifecycleStatusActions,
} from "./package-lifecycle-http.schema.js";
import { lifecycleIntentSchema } from "./package-lifecycle-operation.js";
import { readLifecycleSelection } from "./package-lifecycle-selection.js";

const failure = (message: string, status: number, code: string) =>
  new AppError(message, status, { details: [{ code, message }] });
/** Shares the registered P2A action URL. No controller entry grants activation authority. */
export class PackageLifecycleHttpController {
  constructor(
    private readonly services: PackageLifecycleHttpServices,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  public execute = async (req: Request, res: Response): Promise<void> => {
    await verifyPackageBatchActivation();
    try {
      await this.run(req, res);
    } catch (error) {
      if (error instanceof PackageLifecyclePaymentPendingError) {
        sendSuccess(res, 202, "Session payment unresolved; Booking is not confirmed", {
          state: "PAYMENT_PENDING",
          providerStatus: error.providerStatus,
          paymentAttemptId: error.paymentAttemptId,
          clientSecret: error.clientSecret,
        });
        return;
      }
      if (error instanceof PackageCheckoutConflictError)
        throw failure(
          "Package state, terms or availability changed. Refresh before continuing.",
          409,
          "PACKAGE_LIFECYCLE_CONFLICT",
        );
      if (error instanceof MongooseError.DocumentNotFoundError)
        throw failure(
          "Package appointment or dependency not found",
          404,
          "PACKAGE_PROGRESS_NOT_FOUND",
        );
      if (error instanceof PackageBatchUnresolvedError) {
        sendSuccess(res, 202, "Operation unresolved; retry the identical request", {
          state: "UNRESOLVED",
        });
        return;
      }
      if (
        error instanceof mongo.MongoError ||
        error instanceof MongooseError.MongooseServerSelectionError
      )
        throw failure(
          "Package operation unavailable. Keep the same request key when retrying.",
          503,
          "PACKAGE_LIFECYCLE_UNAVAILABLE",
        );
      throw error;
    }
  };
  private async run(req: Request, res: Response) {
    const action = z.enum(lifecycleHttpActions).parse(req.params["action"]);
    const body = lifecycleHttpSchemas[action].parse(req.body);
    z.object({}).strict().parse(req.query);
    const auth = req.auth;
    if (!auth) throw failure("Sign in required", 401, "AUTH_REQUIRED");
    if (!["CUSTOMER", "BUSINESS_OWNER", "SUPERVISOR"].includes(auth.role))
      throw failure("Package action forbidden", 403, "PACKAGE_LIFECYCLE_FORBIDDEN");
    const statusAction = (lifecycleStatusActions as Record<string, string | undefined>)[action];
    // Each status action is open to exactly the roles that may perform its lifecycle action;
    // the service then binds the stored intent to this exact actor.
    const customerOnly = [
      "redeem",
      "session-quote",
      "session-acceptance",
      "selection",
      "session-status",
    ];
    const customerAllowed = [
      ...customerOnly,
      "reschedule",
      "cancel",
      "expire",
      "reschedule-status",
      "cancel-status",
      "expire-status",
    ];
    if (
      (auth.role !== "CUSTOMER" && customerOnly.includes(action)) ||
      (auth.role === "CUSTOMER" && !customerAllowed.includes(action))
    )
      throw failure("Package action forbidden for this role", 403, "PACKAGE_LIFECYCLE_FORBIDDEN");
    const s = this.services;
    const proof =
      auth.role === "CUSTOMER"
        ? await s.authority.authenticate(req.headers.authorization)
        : undefined;
    const customer = proof ? readPackageCheckoutCustomer(proof) : undefined;
    if (customer && String(customer.userId) !== auth.userId)
      throw failure("Session changed", 403, "PACKAGE_LIFECYCLE_FORBIDDEN");
    if (auth.role !== "CUSTOMER")
      await s.management.requireBookingManagementAccess(
        auth.userId,
        auth.role,
        String(body.businessId),
      );
    const progress = await PackageProgressV2Model.findOne({
      _id: body.packageProgressId,
      businessId: body.businessId,
      schemaVersion: 2,
      ...(customer ? { customerUserId: customer.userId } : {}),
    })
      .maxTimeMS(2000)
      .exec();
    if (!progress || progress.creditAccountingVersion !== 2)
      throw failure("Package not found", 404, "PACKAGE_PROGRESS_NOT_FOUND");
    if (
      !(await BusinessClientModel.exists({
        _id: progress.businessClientId,
        businessId: body.businessId,
        linkedUserId: progress.customerUserId,
      }).maxTimeMS(2000))
    )
      throw failure("Package relationship unavailable", 409, "PACKAGE_LIFECYCLE_CONFLICT");
    if ((await readPackagePurchaseCompletion(progress)) !== "VERIFIED")
      throw failure(
        "Original package purchase is not verified",
        409,
        "PACKAGE_PURCHASE_UNVERIFIED",
      );
    if (action === "selection") {
      const input = lifecycleHttpSchemas.selection.parse(req.body);
      const item = progress.items.find((i) => i.packageItemId.equals(input.packageItemId));
      if (
        !item ||
        item.remainingSessions < 1 ||
        progress.voidedAt ||
        (progress.purchasedContract.validity.mode === "FINITE" &&
          this.clock() >= progress.purchasedContract.validity.expiresAt)
      )
        throw failure("No available credits for this service", 409, "PACKAGE_LIFECYCLE_CONFLICT");
      const result = await readLifecycleSelection(progress, input, s.availability, this.clock());
      const assignments = await AddonServiceAssignmentModel.find({
        businessId: input.businessId,
        serviceId: item.serviceId,
      }).maxTimeMS(2000);
      const addons = await AddonModel.find({
        businessId: input.businessId,
        _id: { $in: assignments.map((a) => a.addonId) },
        status: "ACTIVE",
        archivedAt: { $exists: false },
        priceCents: { $exists: true },
      }).maxTimeMS(2000);
      const staff = (await s.staff.listActiveByBusinessId(input.businessId)).filter((p) =>
        result.days.some((d) =>
          d.slots.some((slot) => slot.eligibleStaffMembershipIds.includes(String(p._id))),
        ),
      );
      const profiles = await s.users.findProfilesByUserIds(staff.map((p) => p.userId));
      sendSuccess(res, 200, "Package session selection", {
        ...result,
        addons: addons.map((a) => ({ id: String(a._id), name: a.name, priceCents: a.priceCents })),
        providers: staff.map((p) => ({
          id: String(p._id),
          name:
            profiles.find((u) => String(u.userId) === String(p.userId))?.firstName ??
            "Professional",
        })),
      });
      return;
    }
    // All caller-selected actor/customer/relationship fields were rejected by strict schemas.
    const { businessId, packageProgressId, ...selected } = body;
    const actionName =
      statusAction ??
      (action === "settlement"
        ? "VENUE_SETTLEMENT"
        : action.startsWith("session-")
          ? "REDEEM"
          : action.toUpperCase().replaceAll("-", "_"));
    const requestFields = { ...selected };
    Reflect.deleteProperty(requestFields, "acceptance");
    const intent = lifecycleIntentSchema.parse({
      ...requestFields,
      version: 1,
      action: actionName,
      businessId,
      packageProgressId,
      businessClientId: progress.businessClientId,
      actorUserId: new Types.ObjectId(auth.userId),
      actorRole: auth.role,
      customerUserId: progress.customerUserId,
    });
    if (action === "session-quote" && proof) {
      const q = await s.operations.presentSession(proof, intent, this.clock());
      sendSuccess(res, 200, "Exact session terms", {
        quoteId: q.quoteId,
        challenge: q.challenge,
        termsHash: q.termsHash,
        disclosureHash: q.disclosureHash,
        disclosure: q.disclosure,
        travelCents: q.terms.travelCents,
        addonsCents: q.terms.addonsCents,
        totalCents: q.terms.totalCents,
        paymentMethod: q.terms.paymentMethod,
        currency: q.terms.currency,
      });
      return;
    }
    if (action === "session-acceptance" && proof) {
      const input = lifecycleHttpSchemas["session-acceptance"].parse(req.body);
      const accepted = await s.operations.acceptSession(
        proof,
        intent,
        input.acceptance,
        this.clock(),
      );
      sendSuccess(res, 200, "Session terms accepted; payment and Booking unconfirmed", {
        state: "ACCEPTED",
        acceptanceId: accepted.acceptanceId,
        acceptedAt: accepted.acceptedAt,
      });
      return;
    }
    const {
      version: _version,
      actorUserId: _actor,
      actorRole: _role,
      customerUserId: _customer,
      ...request
    } = intent;
    if (statusAction) {
      const status =
        action === "session-status" && proof
          ? await s.lifecycle.customerRedemptionStatus(proof, request)
          : proof
            ? await s.lifecycle.customerOperationStatus(proof, request)
            : await s.lifecycle.businessOperationStatus(
                intent.actorUserId,
                auth.role as "BUSINESS_OWNER" | "SUPERVISOR",
                progress.customerUserId,
                request,
              );
      if (!status)
        throw failure("Package operation not found", 404, "PACKAGE_LIFECYCLE_OPERATION_NOT_FOUND");
      if (status.state === "UNRESOLVED") {
        sendSuccess(res, 202, "Operation not confirmed; nothing was changed", {
          state: "UNRESOLVED",
        });
        return;
      }
      const recovered = status.result;
      sendSuccess(res, 200, "Package lifecycle committed", {
        state: "COMMITTED",
        status: recovered.status,
        bookingId: recovered.bookingId,
        startAt: recovered.startAt,
        endAt: recovered.endAt,
        committedAt: recovered.committedAt,
      });
      return;
    }
    const committed = await (async () => {
      try {
        return proof
          ? await s.lifecycle.customer(proof, request)
          : await s.lifecycle.business(
              intent.actorUserId,
              auth.role as "BUSINESS_OWNER" | "SUPERVISOR",
              progress.customerUserId,
              request,
            );
      } catch (error) {
        // Public request parsing already succeeded. Missing/corrupt retained acceptance or
        // result evidence is a state conflict, never a malformed public DTO or success.
        if (error instanceof z.ZodError)
          throw new PackageCheckoutConflictError("Retained lifecycle evidence unavailable");
        throw error;
      }
    })();
    if (!committed) {
      sendSuccess(res, 202, "Operation unresolved", { state: "UNRESOLVED" });
      return;
    }
    const result = committed.result;
    // Never disclose journal tasks, reservations, ledger/PI identifiers or private tokens.
    sendSuccess(res, 200, "Package lifecycle committed", {
      state: "COMMITTED",
      status: result.status,
      bookingId: result.bookingId,
      startAt: result.startAt,
      endAt: result.endAt,
      committedAt: result.committedAt,
    });
  }
}
