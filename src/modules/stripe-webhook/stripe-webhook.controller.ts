import type { Request, Response } from "express";

import { logger } from "../../config/logger.js";
import { PaymentError } from "../payment/payment.errors.js";
import type { StripeWebhookService } from "./stripe-webhook.service.js";

export class StripeWebhookController {
  public constructor(private readonly webhookService: StripeWebhookService) {}

  public handle = async (request: Request, response: Response): Promise<void> => {
    const signature = request.headers["stripe-signature"];
    if (typeof signature !== "string" || !Buffer.isBuffer(request.body)) {
      throw new PaymentError("PAYMENT_WEBHOOK_SIGNATURE_INVALID", 400);
    }

    const event = this.webhookService.verifyAndParse(request.body, signature);

    try {
      await this.webhookService.process(event);
    } catch (error) {
      // Never dumps the raw error/event payload into the response (may contain payment
      // metadata) — logged server-side only, generic 500 to Stripe so it retries.
      logger.error(
        { err: error, eventId: event.id, eventType: event.type },
        "Webhook processing failed",
      );
      response.status(500).json({ success: false, message: "Webhook processing failed" });
      return;
    }

    response.status(200).json({ success: true, message: "Webhook received" });
  };
}
