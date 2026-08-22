import { z } from "zod";

export const confirmSavedPaymentMethodBodySchema = z
  .object({ setupIntentId: z.string().trim().min(1) })
  .strict();

export type ConfirmSavedPaymentMethodBody = z.infer<typeof confirmSavedPaymentMethodBodySchema>;
