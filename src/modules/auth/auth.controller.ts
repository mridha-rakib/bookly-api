import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import {
  clearRefreshCookie,
  getRefreshTokenFromRequest,
  setRefreshCookie,
} from "./auth.cookies.js";
import { AuthError } from "./auth.errors.js";
import type {
  BusinessDetailsBody,
  CategorySelectionBody,
  ChangeMyPasswordBody,
  EntryBody,
  LoginBody,
  ProfessionalEntryBody,
  ProfileBody,
  RequestEmailChangeBody,
  RequestPhoneChangeBody,
  UpdateMyProfileBody,
  VerifyEmailChangeBody,
  VerifyEmailOtpBody,
  VerifyPhoneChangeBody,
  VerifyPhoneOtpBody,
  VisitTypeBody,
} from "./auth.schema.js";
import type { AuthService } from "./auth.service.js";

export class AuthController {
  public constructor(private readonly authService: AuthService) {}

  public customerEntry = async (request: Request, response: Response): Promise<void> => {
    const result = await this.authService.customerEntry(request.validated?.body as EntryBody);
    sendSuccess(response, 200, "Customer entry resolved", result);
  };

  public professionalEntry = async (request: Request, response: Response): Promise<void> => {
    const result = await this.authService.professionalEntry(
      request.validated?.body as ProfessionalEntryBody,
    );
    sendSuccess(response, 200, "Professional entry resolved", result);
  };

  public customerLogin = async (request: Request, response: Response): Promise<void> => {
    const result = await this.authService.login(
      "CUSTOMER",
      request.validated?.body as LoginBody,
      this.getContext(request),
    );
    setRefreshCookie(response, result.refreshToken);
    sendSuccess(response, 200, "Customer login successful", this.withoutRefreshToken(result));
  };

  public professionalLogin = async (request: Request, response: Response): Promise<void> => {
    const result = await this.authService.login(
      "PROFESSIONAL",
      request.validated?.body as LoginBody,
      this.getContext(request),
    );
    setRefreshCookie(response, result.refreshToken);
    sendSuccess(response, 200, "Professional login successful", this.withoutRefreshToken(result));
  };

  public superAdminLogin = async (request: Request, response: Response): Promise<void> => {
    const result = await this.authService.login(
      "SUPER_ADMIN",
      request.validated?.body as LoginBody,
      this.getContext(request),
    );
    setRefreshCookie(response, result.refreshToken);
    sendSuccess(response, 200, "Super Admin login successful", this.withoutRefreshToken(result));
  };

  public sendEmailOtp = async (request: Request, response: Response): Promise<void> => {
    const result = await this.authService.sendEmailOtp(
      request.validated?.body as { sessionId: string },
    );
    sendSuccess(response, 200, "Email verification code sent", result);
  };

  public verifyEmailOtp = async (request: Request, response: Response): Promise<void> => {
    const result = await this.authService.verifyEmailOtp(
      request.validated?.body as VerifyEmailOtpBody,
    );
    sendSuccess(response, 200, "Email verified", result);
  };

  public submitProfile = async (request: Request, response: Response): Promise<void> => {
    const result = await this.authService.submitProfile(request.validated?.body as ProfileBody);
    sendSuccess(response, 200, "Profile saved", result);
  };

  public sendPhoneOtp = async (request: Request, response: Response): Promise<void> => {
    const result = await this.authService.sendPhoneOtp(
      request.validated?.body as { sessionId: string },
    );
    sendSuccess(response, 200, "Phone verification code sent", result);
  };

  public completeCustomer = async (request: Request, response: Response): Promise<void> => {
    const result = await this.authService.verifyCustomerPhoneAndComplete(
      request.validated?.body as VerifyPhoneOtpBody,
      this.getContext(request),
    );
    setRefreshCookie(response, result.refreshToken);
    sendSuccess(response, 201, "Customer account created", this.withoutRefreshToken(result));
  };

  public saveVisitType = async (request: Request, response: Response): Promise<void> => {
    const result = await this.authService.saveProfessionalVisitType(
      request.validated?.body as VisitTypeBody,
    );
    sendSuccess(response, 200, "Business visit type saved", result);
  };

  public verifyProfessionalPhone = async (request: Request, response: Response): Promise<void> => {
    const result = await this.authService.verifyProfessionalPhone(
      request.validated?.body as VerifyPhoneOtpBody,
    );
    sendSuccess(response, 200, "Phone verified", result);
  };

  public saveBusinessDetails = async (request: Request, response: Response): Promise<void> => {
    const result = await this.authService.saveBusinessDetails(
      request.validated?.body as BusinessDetailsBody,
    );
    sendSuccess(response, 200, "Business details saved", result);
  };

  public saveCategories = async (request: Request, response: Response): Promise<void> => {
    const result = await this.authService.saveCategories(
      request.validated?.body as CategorySelectionBody,
    );
    sendSuccess(response, 200, "Business categories saved", result);
  };

  public completeBusinessOwner = async (request: Request, response: Response): Promise<void> => {
    const result = await this.authService.completeBusinessOwner(
      request.validated?.body as { sessionId: string },
      this.getContext(request),
    );
    setRefreshCookie(response, result.refreshToken);
    sendSuccess(response, 201, "Business Owner account created", this.withoutRefreshToken(result));
  };

  public progress = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as { sessionId: string };
    const result = await this.authService.getProgress(query.sessionId);
    sendSuccess(response, 200, "Registration progress", result);
  };

  public refresh = async (request: Request, response: Response): Promise<void> => {
    const refreshToken = getRefreshTokenFromRequest(request);

    if (!refreshToken) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    try {
      const result = await this.authService.refresh(refreshToken);
      setRefreshCookie(response, result.refreshToken);
      sendSuccess(response, 200, "Session refreshed", this.withoutRefreshToken(result));
    } catch (error) {
      if (error instanceof AuthError && error.details?.[0]?.code === "USER_SUSPENDED") {
        clearRefreshCookie(response);
      }

      throw error;
    }
  };

  public logout = async (request: Request, response: Response): Promise<void> => {
    await this.authService.logout(getRefreshTokenFromRequest(request));
    clearRefreshCookie(response);
    sendSuccess(response, 200, "Logged out");
  };

  public me = async (request: Request, response: Response): Promise<void> => {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    const result = await this.authService.getMe(userId);
    sendSuccess(response, 200, "Current user", result);
  };

  public updateMe = async (request: Request, response: Response): Promise<void> => {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    const result = await this.authService.updateMyProfile(
      userId,
      request.validated?.body as UpdateMyProfileBody,
    );
    sendSuccess(response, 200, "Profile updated", result);
  };

  public changeMyPassword = async (request: Request, response: Response): Promise<void> => {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    await this.authService.changeMyPassword(
      userId,
      request.validated?.body as ChangeMyPasswordBody,
    );
    sendSuccess(response, 200, "Password changed");
  };

  public updateMyAvatar = async (request: Request, response: Response): Promise<void> => {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    const file = request.file
      ? {
          buffer: request.file.buffer,
          mimeType: request.file.mimetype,
          size: request.file.size,
        }
      : undefined;

    const result = await this.authService.updateMyAvatar(userId, file);
    sendSuccess(response, 200, "Avatar updated", result);
  };

  public requestEmailChange = async (request: Request, response: Response): Promise<void> => {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    const result = await this.authService.requestEmailChange(
      userId,
      request.validated?.body as RequestEmailChangeBody,
    );
    sendSuccess(response, 200, "Verification code sent to new email", result);
  };

  public verifyEmailChange = async (request: Request, response: Response): Promise<void> => {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    const result = await this.authService.verifyEmailChange(
      userId,
      request.validated?.body as VerifyEmailChangeBody,
    );
    sendSuccess(response, 200, "Email changed", result);
  };

  public requestPhoneChange = async (request: Request, response: Response): Promise<void> => {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    const result = await this.authService.requestPhoneChange(
      userId,
      request.validated?.body as RequestPhoneChangeBody,
    );
    sendSuccess(response, 200, "Verification code sent to new phone", result);
  };

  public verifyPhoneChange = async (request: Request, response: Response): Promise<void> => {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    const result = await this.authService.verifyPhoneChange(
      userId,
      request.validated?.body as VerifyPhoneChangeBody,
    );
    sendSuccess(response, 200, "Phone changed", result);
  };

  private getContext(request: Request) {
    return {
      ...(request.headers["user-agent"] ? { userAgent: request.headers["user-agent"] } : {}),
      ...(request.ip ? { ipAddress: request.ip } : {}),
    };
  }

  private withoutRefreshToken<T extends { refreshToken: string }>(
    input: T,
  ): Omit<T, "refreshToken"> {
    const { refreshToken: _refreshToken, ...rest } = input;
    return rest;
  }
}
