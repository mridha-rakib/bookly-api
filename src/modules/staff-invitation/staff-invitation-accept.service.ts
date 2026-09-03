import mongoose from "mongoose";

import {
  type GoogleVerifiedIdentity,
  splitGoogleName,
} from "../../common/oauth/google-identity.js";
import { logger } from "../../config/logger.js";
import { createOpaqueToken, normalizeEmail, safeCompare } from "../auth/auth.utils.js";
import { type AuthResult, issueAuthSession, type RequestContext } from "../auth/auth-session.js";
import type { PasswordHasher } from "../auth/password-hasher.js";
import type { LinkedAccountRepository } from "../linked-account/linked-account.repository.js";
import type { StaffRepository } from "../staff/staff.repository.js";
import type { StaffCreatableRole } from "../staff/staff.types.js";
import type { UserDocument } from "../user/user.model.js";
import type { UserRepository } from "../user/user.repository.js";
import { StaffInvitationError } from "./staff-invitation.errors.js";
import type { StaffInvitationDocument } from "./staff-invitation.model.js";
import type { StaffInvitationRepository } from "./staff-invitation.repository.js";
import type { StaffInvitationService } from "./staff-invitation.service.js";
import {
  buildStaffInvitationGoogleAuthUrl,
  resolveStaffInvitationGoogleIdentity,
} from "./staff-invitation-google.client.js";
import {
  signStaffInvitationGoogleState,
  verifyStaffInvitationGoogleState,
} from "./staff-invitation-google.state.js";

const GOOGLE_PROVIDER = "GOOGLE" as const;

export type AcceptWithPasswordInput = {
  token: string;
  password: string;
  firstName: string;
  lastName: string;
  phone?: { countryCode: string; nationalNumber: string; e164: string } | undefined;
  agreeTerms: boolean;
};

export type StaffInvitationAcceptResult = {
  auth: AuthResult;
  role: StaffCreatableRole;
};

export type StaffInvitationGoogleAuthorization = {
  url: string;
  nonce: string;
};

export type StaffInvitationGoogleCallbackResult =
  | { type: "SESSION"; auth: AuthResult; role: StaffCreatableRole }
  /** The verified Google email is not the invited address — NEVER provision. */
  | { type: "EMAIL_MISMATCH" }
  /** The invitation is no longer PENDING / has expired / was consumed. */
  | { type: "EXPIRED" }
  | { type: "ERROR" };

/**
 * Provisioning half of the Phase 2D staff/supervisor invitation flow. Accepting an invitation is
 * the ONLY way a SUPERVISOR/STAFF User comes into existence — there is no self-registration, no
 * customer/professional signup path, and Google is never an account-creation path on its own.
 *
 * Both acceptance paths converge on ONE transaction:
 *   User (+ authProviders)  →  UserProfile  →  StaffMembership  →  invitation → ACCEPTED  →  session
 *
 * Security rules enforced here:
 *  - the invitation must be PENDING and unexpired at accept time (CAS-guarded consume);
 *  - `role` + `businessId` for the new User/StaffMembership come ONLY from the server-side
 *    invitation row — never from the request or a callback query param;
 *  - the Google path binds the browser to the flow with a signed `state` nonce == cookie nonce;
 *  - the Google identity is id_token-verified with `email_verified === true`, AND its email must
 *    equal the invited address — a Google account for a different mailbox can never accept;
 *  - a Google `sub` already linked elsewhere, or an email already on any User, is rejected with
 *    a stable domain error — never a silent merge / re-link.
 */
export class StaffInvitationAcceptService {
  public constructor(
    private readonly staffInvitationService: StaffInvitationService,
    private readonly staffInvitationRepository: StaffInvitationRepository,
    private readonly userRepository: UserRepository,
    private readonly staffRepository: StaffRepository,
    private readonly linkedAccountRepository: LinkedAccountRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly tokenService: TokenServiceLike,
  ) {}

  // --- Password acceptance -------------------------------------------------------------------

  public async acceptWithPassword(
    input: AcceptWithPasswordInput,
    context: RequestContext,
  ): Promise<StaffInvitationAcceptResult> {
    if (!input.agreeTerms) {
      throw new StaffInvitationError("STAFF_INVITATION_TOKEN_INVALID", 400, [
        { path: "agreeTerms", message: "You must accept the Terms to continue", code: "required" },
      ]);
    }

    // PENDING + unexpired (throws STAFF_INVITATION_* otherwise).
    const invitation = await this.staffInvitationService.redeemToken(input.token);
    const passwordHash = await this.passwordHasher.hash(input.password);

    const auth = await this.provision(invitation, context, {
      authProvider: "PASSWORD",
      userFields: { authProviders: ["PASSWORD"], passwordHash },
      firstName: input.firstName,
      lastName: input.lastName,
      ...(input.phone ? { phone: input.phone } : {}),
    });

    return { auth, role: invitation.role };
  }

  // --- Google acceptance ------------------------------------------------------------------

  public async buildGoogleAuthorization(
    token: string,
  ): Promise<StaffInvitationGoogleAuthorization> {
    // Fail fast if the token is bad — no consent redirect for a dead invitation.
    const invitation = await this.staffInvitationService.redeemToken(token);
    const nonce = createOpaqueToken();
    const state = await signStaffInvitationGoogleState({
      nonce,
      invitationId: String(invitation._id),
    });
    return { url: buildStaffInvitationGoogleAuthUrl(state), nonce };
  }

  public async completeGoogleCallback(
    input: { code: string; state: string; nonceCookie: string | undefined },
    context: RequestContext,
  ): Promise<StaffInvitationGoogleCallbackResult> {
    let nonce: string;
    let invitationId: string;
    try {
      ({ nonce, invitationId } = await verifyStaffInvitationGoogleState(input.state));
    } catch {
      return { type: "ERROR" };
    }

    if (!input.nonceCookie || !safeCompare(nonce, input.nonceCookie)) {
      return { type: "ERROR" };
    }

    let identity: GoogleVerifiedIdentity;
    try {
      identity = await resolveStaffInvitationGoogleIdentity(input.code);
    } catch {
      return { type: "ERROR" };
    }

    if (!identity.emailVerified) {
      return { type: "ERROR" };
    }

    // Re-load the invitation named by the signed state; it must still be consumable.
    const invitation = await this.staffInvitationRepository.findById(invitationId);
    if (!invitation) {
      return { type: "EXPIRED" };
    }
    if (invitation.status !== "PENDING" || invitation.expiresAt.getTime() <= Date.now()) {
      return { type: "EXPIRED" };
    }

    // The Google account MUST be the invited mailbox — this is what stops "accept someone
    // else's invitation with my Google account".
    if (normalizeEmail(identity.email) !== normalizeEmail(invitation.email)) {
      return { type: "EMAIL_MISMATCH" };
    }

    const { firstName, lastName } = splitGoogleName(identity);

    try {
      const auth = await this.provision(invitation, context, {
        authProvider: "GOOGLE",
        userFields: { authProviders: ["GOOGLE"] },
        firstName,
        lastName,
        google: {
          providerAccountId: identity.providerAccountId,
          ...(identity.displayName ? { displayName: identity.displayName } : {}),
        },
      });
      return { type: "SESSION", auth, role: invitation.role };
    } catch (error) {
      if (error instanceof StaffInvitationError) {
        // e.g. STAFF_INVITATION_NOT_PENDING (lost a race), STAFF_INVITATION_ALREADY_MEMBER.
        return { type: "EXPIRED" };
      }
      logger.error({ err: error }, "Staff invitation Google acceptance failed");
      return { type: "ERROR" };
    }
  }

  // --- Shared provisioning transaction --------------------------------------------------

  private async provision(
    invitation: StaffInvitationDocument,
    context: RequestContext,
    input: {
      authProvider: "PASSWORD" | "GOOGLE";
      userFields: { authProviders: ["PASSWORD"] | ["GOOGLE"]; passwordHash?: string };
      firstName: string;
      lastName: string;
      phone?: { countryCode: string; nationalNumber: string; e164: string } | undefined;
      google?: { providerAccountId: string; displayName?: string } | undefined;
    },
  ): Promise<AuthResult> {
    const normalizedEmail = normalizeEmail(invitation.email);

    // Defence in depth beyond `issue`'s check — the address must not have become a User in the
    // window between issue and accept.
    if (await this.userRepository.findByEmail(normalizedEmail)) {
      throw new StaffInvitationError("STAFF_INVITATION_EMAIL_IN_USE", 409);
    }

    if (input.google) {
      const linkClash = await this.linkedAccountRepository.findByProviderAccount(
        GOOGLE_PROVIDER,
        input.google.providerAccountId,
      );
      if (linkClash) {
        throw new StaffInvitationError("STAFF_INVITATION_EMAIL_IN_USE", 409);
      }
    }

    const now = new Date();
    const dbSession = await mongoose.startSession();
    let auth: AuthResult | undefined;

    try {
      await dbSession.withTransaction(async () => {
        const user: UserDocument = await this.userRepository.create(
          {
            normalizedEmail,
            role: invitation.role,
            status: "ACTIVE",
            emailVerifiedAt: now,
            ...input.userFields,
          },
          dbSession,
        );

        await this.userRepository.createProfile(
          {
            userId: user._id,
            firstName: input.firstName,
            lastName: input.lastName,
            // Neither acceptance path collects gender; "other" is the enum's genuine
            // "unspecified" value (same precedent as staff creation / Google customer signup).
            gender: "other",
            termsAcceptedAt: now,
            ...(input.phone ? { phone: input.phone } : {}),
          },
          dbSession,
        );

        await this.staffRepository.create(
          {
            userId: user._id,
            businessId: invitation.businessId,
            role: invitation.role,
            createdByUserId: invitation.invitedByUserId,
          },
          dbSession,
        );

        if (input.google) {
          await this.linkedAccountRepository.create(
            {
              userId: user._id,
              provider: GOOGLE_PROVIDER,
              providerAccountId: input.google.providerAccountId,
              email: normalizedEmail,
              emailVerified: true,
              ...(input.google.displayName ? { displayName: input.google.displayName } : {}),
              linkedAt: now,
            },
            dbSession,
          );
        }

        const accepted = await this.staffInvitationRepository.markAccepted(
          invitation._id,
          user._id,
          now,
          dbSession,
        );

        if (!accepted) {
          // Concurrent revoke / expire / second accept — abort the whole transaction.
          throw new StaffInvitationError("STAFF_INVITATION_NOT_PENDING", 409);
        }

        await this.staffInvitationRepository.setAcceptanceMeta(
          invitation._id,
          {
            authProvider: input.authProvider,
            ...(input.google ? { googleProviderAccountId: input.google.providerAccountId } : {}),
          },
          dbSession,
        );

        auth = await issueAuthSession(
          this.tokenService,
          { userId: user._id, email: normalizedEmail, role: invitation.role, status: "ACTIVE" },
          context,
          dbSession,
        );
      });
    } catch (error) {
      if (this.isTransactionUnsupported(error)) {
        throw new StaffInvitationError("STAFF_INVITATION_TRANSACTION_UNAVAILABLE", 503);
      }
      if (this.isDuplicateKeyError(error)) {
        // A racing accept created the User / membership / link first, or this email is already
        // an active staff member elsewhere (partial-unique StaffMembership.userId).
        throw new StaffInvitationError("STAFF_INVITATION_ALREADY_MEMBER", 409);
      }
      throw error;
    } finally {
      await dbSession.endSession();
    }

    if (!auth) {
      throw new StaffInvitationError("STAFF_INVITATION_TRANSACTION_UNAVAILABLE", 503);
    }

    return auth;
  }

  private isTransactionUnsupported(error: unknown): boolean {
    return (
      error instanceof Error &&
      /transaction numbers are only allowed|replica set member/i.test(error.message)
    );
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}

/** Structural subset of TokenService that {@link issueAuthSession} needs — keeps this service
 * decoupled from the concrete class, matching how the Google auth services type it. */
type TokenServiceLike = Parameters<typeof issueAuthSession>[0];
