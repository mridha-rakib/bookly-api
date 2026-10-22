import { Router } from "express";
import { Error as MongooseError, mongo, Types } from "mongoose";
import { z } from "zod";
import { AppError } from "../../common/errors/app-error.js";
import { sendSuccess } from "../../common/http/responses.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { env } from "../../config/env.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../auth/auth.middleware.js";
import { PackageCheckoutConflictError } from "./package-checkout.errors.js";
import { packageCheckoutAffirmativeActionSchema } from "./package-checkout-acceptance.js";
import { packageCheckoutIntentSchema } from "./package-checkout-contract.js";
import { readPackageCheckoutCustomer } from "./package-checkout-customer-authority.js";
import { buildPackageConsentServices } from "./package-consent.factory.js";

const objectId = z
  .string()
  .regex(/^[a-fA-F0-9]{24}$/)
  .transform((s) => new Types.ObjectId(s));
const baseIntent = packageCheckoutIntentSchema.shape;
const selection = baseIntent.selections.element;
const intentSchema = packageCheckoutIntentSchema.extend({
  packageId: objectId,
  selections: z
    .array(
      selection.extend({
        selectionId: objectId,
        definitionItemId: objectId,
        serviceId: objectId,
        staffMembershipId: objectId,
        startAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
        addonIds: z.array(objectId).max(50),
      }),
    )
    .min(1),
});
const quoteBody = z.object({ operationId: z.uuid(), intent: intentSchema }).strict();
const actionSchema = packageCheckoutAffirmativeActionSchema.extend({ presentationId: objectId });
const paramsSchema = z.object({ businessId: objectId, operationId: z.uuid() });
const consentError = (message: string, status: number, code: string) =>
  new AppError(message, status, { details: [{ message, code }] });
export type PackageConsentServices = ReturnType<typeof buildPackageConsentServices>;
type Options = {
  enabled?: boolean;
  lifetimeMs?: number;
  origins?: string[];
  build?: (lifetime: number) => PackageConsentServices;
};
export const packageConsentOperationKey = (customerId: Types.ObjectId, operationId: string) =>
  `package-consent:${customerId.toHexString()}:${operationId}`;

/** All routes are consent-only and gated before auth, composition, reads or writes. */
export const createPackageConsentRoute = (options: Options = {}): Router => {
  const router = Router();
  let services: PackageConsentServices | undefined;
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!(options.enabled ?? env.PACKAGE_CONSENT_ENABLED))
      return next(
        consentError("Package terms review is unavailable", 404, "PACKAGE_CONSENT_DISABLED"),
      );
    const origin = req.headers.origin;
    if (origin && !(options.origins ?? env.CORS_ORIGINS).includes(origin))
      return next(consentError("Origin is not allowed", 403, "PACKAGE_CONSENT_ORIGIN_REJECTED"));
    const lifetime = options.lifetimeMs ?? env.PACKAGE_CONSENT_QUOTE_LIFETIME_MS;
    if (!lifetime)
      return next(
        consentError(
          "Package quote lifetime requires server configuration",
          503,
          "PACKAGE_CONSENT_NOT_CONFIGURED",
        ),
      );
    services ??= (options.build ?? buildPackageConsentServices)(lifetime);
    next();
  });
  router.use(
    (req, res, next) => {
      if (!services) return next(new Error("Consent composition missing"));
      return createAuthenticateAccessTokenMiddleware(services.tokens, services.users)(
        req,
        res,
        next,
      );
    },
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
  );
  // Map existing internal foundation failures into the established safe HTTP envelope.
  const handle = (fn: Parameters<typeof asyncHandler>[0]) =>
    asyncHandler(async (req, res, next) => {
      try {
        await fn(req, res, next);
      } catch (error) {
        if (error instanceof AppError || error instanceof z.ZodError) throw error;
        if (error instanceof PackageCheckoutConflictError)
          throw consentError(
            "These terms or your session have changed. Start a fresh terms review.",
            409,
            "PACKAGE_CONSENT_CHANGED",
          );
        if (
          error instanceof mongo.MongoError ||
          error instanceof MongooseError.MongooseServerSelectionError
        )
          throw consentError(
            "Terms review is temporarily unavailable. Please try again later.",
            503,
            "PACKAGE_CONSENT_UNAVAILABLE",
          );
        // Unknown failures retain the shared safe 500/logging path, not a fabricated conflict.
        throw error;
      }
    });
  const get = () => {
    if (!services) throw new Error("Consent composition missing");
    return services;
  };
  router.get(
    "/:businessId/offers/:packageId",
    handle(async (req, res) => {
      const s = get(),
        businessId = objectId.parse(req.params["businessId"]),
        packageId = objectId.parse(req.params["packageId"]);
      const business = await s.businesses.findById(businessId);
      const definition = await s.packages.findById(businessId, packageId.toHexString());
      if (
        !business ||
        !["APPROVED", "WARNING"].includes(business.status) ||
        !definition ||
        definition.status !== "ACTIVE" ||
        !definition.contractTerms
      )
        throw consentError("Package offer not found", 404, "PACKAGE_CONSENT_OFFER_NOT_FOUND");
      // First UI slice supports at-Business selections. Travel consent remains API-supported via canonical intent.
      if (business.visitType !== "AT_BUSINESS_LOCATION")
        throw consentError(
          "This terms review currently supports appointments at the Business",
          409,
          "PACKAGE_CONSENT_VISIT_UNSUPPORTED",
        );
      const staff = (await s.staff.listActiveByBusinessId(businessId)).filter(
        (p) => p.employmentActive,
      );
      const profiles = await s.users.findProfilesByUserIds(staff.map((p) => p.userId));
      const services = await s.services.findManyByIdsForBusiness(
        businessId,
        definition.items.map((i) => i.serviceId),
      );
      sendSuccess(res, 200, "Package terms selection", {
        businessId,
        packageId,
        name: definition.name,
        revision: definition.revision,
        timezone: business.timezone,
        items: definition.items.map((i) => ({
          definitionItemId: i.itemId,
          serviceId: i.serviceId,
          name: services.find((s) => s._id.equals(i.serviceId))?.name,
          quantity: i.includedSessions,
          providers: staff
            .filter((p) =>
              services
                .find((s) => s._id.equals(i.serviceId))
                ?.assignedStaffMembershipIds.some((id) => id.equals(p._id)),
            )
            .flatMap((p) => {
              const profile = profiles.find((profile) => profile.userId.equals(p.userId));
              return profile
                ? [{ id: p._id, name: `${profile.firstName} ${profile.lastName}` }]
                : [];
            }),
        })),
      });
    }),
  );
  router.post(
    "/:businessId/quotes",
    handle(async (req, res) => {
      const s = get(),
        body = quoteBody.parse(req.body),
        businessId = objectId.parse(req.params["businessId"]);
      const proof = await s.authority.authenticate(req.headers.authorization),
        customer = readPackageCheckoutCustomer(proof);
      const key = packageConsentOperationKey(customer.userId, body.operationId);
      await s.retention.prepareAndRetain(
        {
          businessId,
          customerUserId: customer.userId,
          actorUserId: customer.userId,
          role: "CUSTOMER",
        },
        key,
        body.intent,
      );
      sendSuccess(res, 200, "Package quote retained", { operationId: body.operationId });
    }),
  );
  router.post(
    "/:businessId/operations/:operationId/presentation",
    handle(async (req, res) => {
      z.object({}).strict().parse(req.body);
      const s = get(),
        params = paramsSchema.parse(req.params);
      const customer = readPackageCheckoutCustomer(
        await s.authority.authenticate(req.headers.authorization),
      );
      const p = await s.acceptance.present(
        req.headers.authorization,
        params.businessId,
        packageConsentOperationKey(customer.userId, params.operationId),
      );
      const stored = await s.claims.findPackageCheckoutForCustomer(
        await s.authority.authenticate(req.headers.authorization),
        params.businessId,
        packageConsentOperationKey(customer.userId, params.operationId),
      );
      const accepted = stored.accepted;
      // Explicit DTO: never serialize the private session-family id or retained seed.
      sendSuccess(res, 200, "Package terms ready", {
        version: p.version,
        presentationId: p.presentationId,
        challenge: p.challenge,
        templateVersion: p.disclosure.content.templateVersion,
        quoteHash: p.disclosure.content.quoteHash,
        disclosureHash: p.disclosure.contentHash,
        text: p.disclosure.content.renderedTermsSnapshot,
        ...(accepted
          ? {
              accepted: {
                state: accepted.state,
                acceptanceId: accepted.evidence.acceptanceId,
                acceptedAt: accepted.evidence.acceptedAt,
                presentationId: accepted.event.presentationId,
                quoteHash: accepted.event.quoteHash,
                disclosureHash: accepted.disclosureHash,
                eventId: accepted.event.eventId,
              },
            }
          : {}),
      });
    }),
  );
  router.post(
    "/:businessId/operations/:operationId/acceptance",
    handle(async (req, res) => {
      const action = actionSchema.parse(req.body),
        s = get(),
        params = paramsSchema.parse(req.params);
      const customer = readPackageCheckoutCustomer(
        await s.authority.authenticate(req.headers.authorization),
      );
      const accepted = await s.acceptance.accept(
        req.headers.authorization,
        params.businessId,
        packageConsentOperationKey(customer.userId, params.operationId),
        action,
      );
      sendSuccess(res, 200, "Terms accepted", {
        state: accepted.state,
        acceptanceId: accepted.evidence.acceptanceId,
        acceptedAt: accepted.evidence.acceptedAt,
        presentationId: accepted.event.presentationId,
        quoteHash: accepted.event.quoteHash,
        disclosureHash: accepted.disclosureHash,
        eventId: accepted.event.eventId,
      });
    }),
  );
  router.get(
    "/:businessId/operations/:operationId/acceptance",
    handle(async (req, res) => {
      const s = get(),
        params = paramsSchema.parse(req.params);
      const customer = await s.authority.authenticate(req.headers.authorization);
      const owner = readPackageCheckoutCustomer(customer);
      const row = await s.claims.findPackageCheckoutForCustomer(
        customer,
        params.businessId,
        packageConsentOperationKey(owner.userId, params.operationId),
      );
      const accepted = row.accepted;
      sendSuccess(
        res,
        200,
        "Stored terms acceptance",
        accepted
          ? {
              state: accepted.state,
              acceptanceId: accepted.evidence.acceptanceId,
              acceptedAt: accepted.evidence.acceptedAt,
              presentationId: accepted.event.presentationId,
              quoteHash: accepted.event.quoteHash,
              disclosureHash: accepted.disclosureHash,
              eventId: accepted.event.eventId,
            }
          : { state: "NOT_ACCEPTED" },
      );
    }),
  );
  return router;
};
