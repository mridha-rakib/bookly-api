import { z } from "zod";

export const confirmSavedPaymentMethodBodySchema = z
  .object({ setupIntentId: z.string().trim().min(1) })
  .strict();

export type ConfirmSavedPaymentMethodBody = z.infer<typeof confirmSavedPaymentMethodBodySchema>;

/** P2.2.5 — a Stripe PaymentMethod id in the path; ownership is checked server-side. */
export const savedPaymentMethodParamsSchema = z
  .object({
    paymentMethodId: z.string().regex(/^pm_[A-Za-z0-9]{1,250}$/, "Invalid payment method"),
  })
  .strict();
export type SavedPaymentMethodParams = z.infer<typeof savedPaymentMethodParamsSchema>;
