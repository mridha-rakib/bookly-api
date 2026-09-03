import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { setRefreshCookie } from "../auth/auth.cookies.js";
import { normalizePhoneNumber } from "../auth/auth.utils.js";
import type { BusinessRepository } from "../business/business.repository.js";
import {
  clearOAuthNonceCookie,
  readOAuthNonceCookie,
  setOAuthNonceCookie,
} from "./staff-invitation.nonce.js";
import type {
  AcceptStaffInvitationPasswordBody,
  StaffInvitationGoogleCallbackQuery,
  StaffInvitationGoogleStartQuery,
  StaffInvitationTokenQuery,
} from "./staff-invitation.schema.js";
import type { StaffInvitationService } from "./staff-invitation.service.js";
import type { StaffInvitationAcceptService } from "./staff-invitation-accept.service.js";
import { isStaffInvitationGoogleConfigured } from "./staff-invitation-google.client.js";

/** Coarse outcomes the frontend `/auth/google/callback?flow=staff` page branches on. Nothing
 * else — no tokens, emails, ids, or reasons — goes in the redirect URL. */
type CallbackStatus = "success" | "email_mismatch" | "expired" | "error";

/**
 * HTTP boundary for Phase 2D staff/supervisor invitation acceptance. Owns the staff nonce
 * cookie, the refresh cookie (via the shared setRefreshCookie), and the always-redirect-to-
 * frontend contract for the Google callback. No session is required on any of these routes —
 * security is the invitation token + signed state + nonce cookie.
 */
export class StaffInvitationController {
  public constructor(
    private readonly invitationService: StaffInvitationService,
    private readonly acceptService: StaffInvitationAcceptService,
    private readonly businessRepository: BusinessRepository,
  ) {}

  /** GET /auth/staff/invitation?token= — render the accept screen. Safe, non-secret fields only. */
  public getInvitation = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as StaffInvitationTokenQuery;
    const invitation = await this.invitationService.redeemToken(query.token);
    const business = await this.businessRepository.findById(invitation.businessId);

    sendSuccess(response, 200, "Invitation", {
      email: invitation.email,
      role: invitation.role,
      businessName: business?.name ?? "your team",
      expiresAt: invitation.expiresAt.toISOString(),
      ...(invitation.firstName ? { firstName: invitation.firstName } : {}),
      ...(invitation.lastName ? { lastName: invitation.lastName } : {}),
    });
  };

  /** POST /auth/staff/invitation/accept/password */
  public acceptWithPassword = async (request: Request, response: Response): Promise<void> => {
    const body = request.validated?.body as AcceptStaffInvitationPasswordBody;

    const phone =
      body.countryCode && body.nationalNumber
        ? normalizePhoneNumber(body.countryCode, body.nationalNumber)
        : undefined;

    const result = await this.acceptService.acceptWithPassword(
      {
        token: body.token,
        password: body.password,
        firstName: body.firstName,
        lastName: body.lastName,
        agreeTerms: body.agreeTerms,
        ...(phone ? { phone } : {}),
      },
      this.requestContext(request),
    );

    setRefreshCookie(response, result.auth.refreshToken);
    const { refreshToken: _refreshToken, ...auth } = result.auth;
    sendSuccess(response, 201, "Invitation accepted", auth);
  };

  /** GET /auth/staff/invitation/oauth/google/start?token= */
  public googleStart = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as StaffInvitationGoogleStartQuery;

    if (!isStaffInvitationGoogleConfigured()) {
      response.redirect(this.frontendRedirect("error"));
      return;
    }

    try {
      const { url, nonce } = await this.acceptService.buildGoogleAuthorization(query.token);
      setOAuthNonceCookie(response, nonce);
      response.redirect(url);
    } catch (error) {
      // A dead / expired / consumed token — never start a consent round-trip for it.
      logger.warn({ err: error }, "Staff invitation Google start rejected");
      response.redirect(this.frontendRedirect("expired"));
    }
  };

  /** GET /auth/staff/invitation/oauth/google/callback */
  public googleCallback = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as StaffInvitationGoogleCallbackQuery;

    const nonceCookie = readOAuthNonceCookie(request);
    clearOAuthNonceCookie(response);

    if (query.error || !query.code || !query.state) {
      response.redirect(this.frontendRedirect("error"));
      return;
    }

    let result: Awaited<ReturnType<StaffInvitationAcceptService["completeGoogleCallback"]>>;
    try {
      result = await this.acceptService.completeGoogleCallback(
        { code: query.code, state: query.state, nonceCookie },
        this.requestContext(request),
      );
    } catch (error) {
      logger.warn({ err: error }, "Staff invitation Google callback failed");
      response.redirect(this.frontendRedirect("error"));
      return;
    }

    if (result.type === "SESSION") {
      setRefreshCookie(response, result.auth.refreshToken);
      response.redirect(this.frontendRedirect("success"));
      return;
    }

    if (result.type === "EMAIL_MISMATCH") {
      response.redirect(this.frontendRedirect("email_mismatch"));
      return;
    }

    if (result.type === "EXPIRED") {
      response.redirect(this.frontendRedirect("expired"));
      return;
    }

    response.redirect(this.frontendRedirect("error"));
  };

  private frontendRedirect(status: CallbackStatus): string {
    return `${env.FRONTEND_BASE_URL}/auth/google/callback?flow=staff&status=${status}`;
  }

  private requestContext(request: Request): { userAgent?: string; ipAddress?: string } {
    return {
      ...(request.headers["user-agent"] ? { userAgent: request.headers["user-agent"] } : {}),
      ...(request.ip ? { ipAddress: request.ip } : {}),
    };
  }
}
