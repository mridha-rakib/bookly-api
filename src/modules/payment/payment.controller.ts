import type { Request, Response } from "express";
import { sendSuccess } from "../../common/http/responses.js";
import { AuthError } from "../auth/auth.errors.js";
import type { ConfirmSavedPaymentMethodBody, SavedPaymentMethodParams } from "./payment.schema.js";
import type { PaymentService } from "./payment.service.js";
import type { SavedCardRemovalService } from "./saved-card-removal.service.js";

/** Customer self-service saved-card management — the minimal Batch 4 endpoints the frontend
 * payment step needs: create a SetupIntent (to collect a card via Stripe Elements), confirm it
 * once Stripe.js has confirmed it client-side, and read the current saved-card status. */
export class PaymentController {
  public constructor(
    private readonly paymentService: PaymentService,
    private readonly savedCardRemovalService?: SavedCardRemovalService,
  ) {}

  /** P2.2.5 — the Customer comes only from the session; the path id is checked for ownership. */
  public removeSavedPaymentMethod = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    if (!this.savedCardRemovalService) throw new AuthError("PORTAL_MISMATCH", 403);
    const params = request.validated?.params as SavedPaymentMethodParams;
    const result = await this.savedCardRemovalService.removeSavedCard(
      userId,
      params.paymentMethodId,
    );
    sendSuccess(response, 200, "Saved card removed", result);
  };

  public createSetupIntent = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const result = await this.paymentService.createSetupIntent(userId);
    sendSuccess(response, 201, "Setup intent created", result);
  };

  public confirmSavedPaymentMethod = async (
    request: Request,
    response: Response,
  ): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const body = request.validated?.body as ConfirmSavedPaymentMethodBody;
    const summary = await this.paymentService.confirmSavedPaymentMethod(userId, body.setupIntentId);
    sendSuccess(response, 200, "Card saved", summary);
  };

  public getSavedCardStatus = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireCustomerId(request);
    const status = await this.paymentService.getSavedCardStatus(userId);
    sendSuccess(response, 200, "Saved card status", status);
  };

  private requireCustomerId(request: Request): string {
    const userId = request.auth?.userId;
    if (!userId || request.auth?.role !== "CUSTOMER") {
      throw new AuthError("PORTAL_MISMATCH", 403);
    }
    return userId;
  }
}
