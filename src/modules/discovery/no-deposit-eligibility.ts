import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { sendSuccess } from "../../common/http/responses.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../auth/auth.middleware.js";
import { TokenService } from "../auth/token.service.js";
import { newPurchaseReturningUpfrontCents } from "../booking/financial-contract.js";
import { BusinessModel } from "../business/business.model.js";
import { BusinessClientModel } from "../client/client.model.js";
import { createFinancialRelationshipService } from "../client/financial-relationship.factory.js";
import { ServiceModel } from "../services/service.model.js";
import { SessionRepository } from "../session/session.repository.js";
import { UserRepository } from "../user/user.repository.js";

const id = z.string().regex(/^[a-f\d]{24}$/i);
export const noDepositEligibilitySchema = z
  .object({
    selections: z.array(z.object({ businessId: id, serviceId: id.optional() }).strict()).max(60),
  })
  .strict();
export type HomeEligibilitySelection = z.infer<
  typeof noDepositEligibilitySchema
>["selections"][number];
export const noDepositEligibilityQuerySchema = z
  .object({
    selections: z
      .string()
      .max(20000)
      .transform((value, context) => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          context.addIssue({ code: "custom", message: "Invalid selections" });
          return z.NEVER;
        }
      })
      .pipe(noDepositEligibilitySchema.shape.selections),
  })
  .strict();

/** Read-only preview projection. Only booleans leave this private endpoint; neither relationship
 * records nor history are exposed. The current Checkout quote still wins over this hint. */
export async function readHomeNoDepositEligibility(
  customerId: string,
  selections: HomeEligibilitySelection[],
) {
  const unique = [
    ...new Map(
      selections.map((selection) => [
        `${selection.businessId}:${selection.serviceId ?? ""}`,
        selection,
      ]),
    ).values(),
  ];
  const ids = [...new Set(unique.map((selection) => selection.businessId))];
  if (!ids.length) return { scope: "NEW_ORDINARY_BOOKING" as const, selections: [] };
  const [businesses, clients, services] = await Promise.all([
    BusinessModel.find(
      {
        _id: { $in: ids },
        status: { $in: ["APPROVED", "WARNING"] },
        publicVisible: { $ne: false },
      },
      { _id: 1 },
    )
      .lean()
      .exec(),
    BusinessClientModel.find(
      {
        businessId: { $in: ids },
        linkedUserId: new Types.ObjectId(customerId),
        linkState: "LINKED",
        archivedAt: { $exists: false },
      },
      { businessId: 1, financialRelationship: 1, activatedAt: 1 },
    ).exec(),
    // Discovery Business cards represent an ordinary-service catalogue (its starting price
    // excludes Package deals). Specific Book Again services must independently match here.
    ServiceModel.aggregate<{
      _id: { businessId: Types.ObjectId; serviceId: Types.ObjectId | null };
    }>([
      {
        $match: {
          status: "ACTIVE",
          isPackageDeal: false,
          pricingMode: { $in: ["FIXED", "HOURLY", "PER_PERSON"] },
          $or: unique.map((selection) => ({
            businessId: new Types.ObjectId(selection.businessId),
            ...(selection.serviceId ? { _id: new Types.ObjectId(selection.serviceId) } : {}),
          })),
        },
      },
      // Collapse all unselected ordinary services per Business rather than loading an
      // unbounded catalogue into the application just to establish presence.
      {
        $group: {
          _id: {
            businessId: "$businessId",
            serviceId: {
              $cond: [
                {
                  $in: [
                    "$_id",
                    unique.flatMap((selection) =>
                      selection.serviceId ? [new Types.ObjectId(selection.serviceId)] : [],
                    ),
                  ],
                },
                "$_id",
                null,
              ],
            },
          },
        },
      },
    ]).exec(),
  ]);
  const allowedBusinesses = new Set(businesses.map((business) => String(business._id)));
  const clientByBusiness = new Map(clients.map((client) => [String(client.businessId), client]));
  const financial = createFinancialRelationshipService();
  return {
    scope: "NEW_ORDINARY_BOOKING" as const,
    selections: unique.map((selection) => ({
      ...selection,
      noDepositNeeded:
        allowedBusinesses.has(selection.businessId) &&
        services.some(
          (service) =>
            String(service._id.businessId) === selection.businessId &&
            (!selection.serviceId || String(service._id.serviceId) === selection.serviceId),
        ) &&
        newPurchaseReturningUpfrontCents(
          financial.peekClassification(clientByBusiness.get(selection.businessId) ?? null),
        ) === 0,
    })),
  };
}

export function createNoDepositEligibilityRoute(): Router {
  const router = Router();
  router.get(
    "/no-deposit-eligibility",
    createAuthenticateAccessTokenMiddleware(
      new TokenService(new SessionRepository()),
      new UserRepository(),
    ),
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    validateRequest({ query: noDepositEligibilityQuerySchema }),
    asyncHandler(async (request, response) => {
      const body = request.validated?.query as z.infer<typeof noDepositEligibilitySchema>;
      response.setHeader("Cache-Control", "private, no-store");
      sendSuccess(
        response,
        200,
        "Home booking eligibility",
        await readHomeNoDepositEligibility(request.auth?.userId ?? "", body.selections),
      );
    }),
  );
  return router;
}
