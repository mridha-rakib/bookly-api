import type { Request, Response } from "express";

import { AppError } from "../../common/errors/app-error.js";
import { sendSuccess } from "../../common/http/responses.js";
import { logger } from "../../config/logger.js";
import { AuthError } from "../auth/auth.errors.js";
import type { OrdinaryCalendarDispatch } from "../booking/ordinary-calendar-dispatch.js";
import { describeOrdinaryCalendarSync } from "../booking/ordinary-calendar-incident.js";
import {
  ORDINARY_CALENDAR_ISSUER_WINDOW_MS,
  OrdinaryCalendarJournalConflictError,
} from "../booking/ordinary-calendar-journal.js";
import type { OrdinaryCalendarJournalDocument } from "../booking/ordinary-calendar-journal.model.js";
import { OrdinaryCalendarDeliveryUnavailableError } from "../booking/ordinary-calendar-journal-authority.js";
import type { PackageCalendarOwner } from "../booking/package-calendar-authority.js";
import { PackageCalendarProviderError } from "../booking/package-calendar-delivery.js";
import type {
  BookingCalendarRecoveryBody,
  BookingCalendarSyncParams,
} from "./integration.schema.js";

export type OrdinaryCalendarSyncControllerDependencies = {
  ownsBusiness(userId: string, businessId: string): Promise<boolean>;
  bookingBelongsToBusiness(bookingId: string, businessId: string): Promise<boolean>;
  readJournal(
    bookingId: string,
    businessId: string,
  ): Promise<OrdinaryCalendarJournalDocument | null>;
  /** Verifies the Bearer token, its live sid session and the current Owner user. */
  authenticateOwner(authorization: string | undefined): Promise<PackageCalendarOwner>;
  recover(
    ...args: Parameters<OrdinaryCalendarDispatch["recover"]>
  ): ReturnType<OrdinaryCalendarDispatch["recover"]>;
  clock?: () => Date;
};

/**
 * P4B-2C — Owner-facing ordinary Calendar status and exact recovery. Mounted under the
 * Business router's `authenticate` + ACTIVE `BUSINESS_OWNER` + approved-Business gates.
 * Ownership of the Business and Booking is re-checked here (404 for anything foreign). The
 * recovery actor is always the authenticated session, re-verified as a live sid-bound Owner
 * session, never a posted id. Recovery stays behind the default-denied delivery authority (503).
 */
export class OrdinaryCalendarSyncController {
  public constructor(private readonly deps: OrdinaryCalendarSyncControllerDependencies) {}

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;
    if (!userId) throw new AuthError("SESSION_EXPIRED", 401);
    return userId;
  }

  private async requireScope(userId: string, params: BookingCalendarSyncParams) {
    // Same 404 for a foreign Business and a foreign Booking: nothing about another tenant leaks.
    if (
      !(await this.deps.ownsBusiness(userId, params.businessId)) ||
      !(await this.deps.bookingBelongsToBusiness(params.bookingId, params.businessId))
    )
      throw new AppError("Booking not found", 404, { expose: true });
  }

  private now() {
    return this.deps.clock?.() ?? new Date();
  }

  public getStatus = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as BookingCalendarSyncParams;
    await this.requireScope(userId, params);
    const journal = await this.deps.readJournal(params.bookingId, params.businessId);
    sendSuccess(
      response,
      200,
      "Calendar sync status",
      describeOrdinaryCalendarSync(journal, this.now(), ORDINARY_CALENDAR_ISSUER_WINDOW_MS),
    );
  };

  public recover = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as BookingCalendarSyncParams;
    const body = request.validated?.body as BookingCalendarRecoveryBody;
    await this.requireScope(userId, params);
    let proof: PackageCalendarOwner;
    try {
      proof = await this.deps.authenticateOwner(request.headers.authorization);
    } catch {
      throw new AuthError("SESSION_EXPIRED", 401);
    }
    try {
      const recovered = await this.deps.recover(
        {
          bookingId: params.bookingId,
          businessId: params.businessId,
          actorUserId: userId,
          incidentReference: body.incidentReference,
          assertion: body.assertion,
          ...(body.requestId ? { requestId: body.requestId } : {}),
          ...(body.rebindToCurrentConnection ? { rebindToCurrentConnection: true } : {}),
          ...(body.bindUnusedDestination ? { bindUnusedDestination: true } : {}),
        },
        proof,
      );
      const audit = recovered?.recoveries?.at(-1);
      logger.info(
        {
          event: "ORDINARY_CALENDAR_OWNER_RECOVERY",
          bookingId: params.bookingId,
          businessId: params.businessId,
          binding: audit?.binding,
          requestId: audit?.requestId,
        },
        "Ordinary Calendar Owner recovery recorded",
      );
      sendSuccess(response, 200, "Calendar recovery recorded", {
        sync: describeOrdinaryCalendarSync(
          recovered,
          this.now(),
          ORDINARY_CALENDAR_ISSUER_WINDOW_MS,
        ),
        recovery: audit
          ? {
              binding: audit.binding,
              assertion: audit.assertion,
              requestId: audit.requestId,
              incidentReference: audit.incidentReference,
              at: audit.at,
            }
          : undefined,
      });
    } catch (error) {
      if (error instanceof OrdinaryCalendarDeliveryUnavailableError)
        throw new AppError("Calendar delivery is not activated", 503, { expose: true });
      if (error instanceof OrdinaryCalendarJournalConflictError)
        throw new AppError(error.message, 409, { expose: true });
      if (error instanceof PackageCalendarProviderError)
        throw new AppError("The Calendar connection changed during recovery", 409, {
          expose: true,
        });
      if (error instanceof AppError) throw error;
      if (error instanceof Error && error.name === "PackageCheckoutConflictError")
        throw new AuthError("SESSION_EXPIRED", 401); // Owner session no longer verifiable.
      throw error;
    }
  };
}
