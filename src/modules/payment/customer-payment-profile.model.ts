import { model, Schema, type Types } from "mongoose";

/**
 * ONE Stripe Customer per real Bookly CUSTOMER User — global, not Business-scoped. A Stripe
 * Customer represents a real person's saved payment identity; re-creating a separate Stripe
 * Customer (and forcing the card to be re-entered) per Business would be wasteful and is not
 * what any product wording implies. What IS Business-scoped is ACTIVATION (see
 * BusinessClient.activatedAt on client.model.ts) — whether the platform/activation fee has
 * already been charged for this specific Customer+Business pair — which is deliberately a
 * separate concept stored on BusinessClient, not here.
 *
 * Only safe, non-sensitive Stripe identifiers and display metadata are stored — never a raw
 * PAN/CVC (Stripe Elements tokenizes in the browser; this row only ever receives a
 * `pm_...`/`cus_...` id and the card's brand/last4/expiry for display, exactly like every major
 * payments platform's own dashboard shows a saved card).
 */
export type CustomerPaymentProfileDocument = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  stripeCustomerId: string;
  defaultPaymentMethodId?: string | undefined;
  cardBrand?: string | undefined;
  cardLast4?: string | undefined;
  cardExpMonth?: number | undefined;
  cardExpYear?: number | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const customerPaymentProfileSchema = new Schema<CustomerPaymentProfileDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    stripeCustomerId: { type: String, required: true, trim: true },
    defaultPaymentMethodId: { type: String, trim: true },
    cardBrand: { type: String, trim: true },
    cardLast4: { type: String, trim: true, match: /^\d{4}$/ },
    cardExpMonth: { type: Number, min: 1, max: 12 },
    cardExpYear: { type: Number, min: 2000 },
  },
  { timestamps: true },
);

// One payment profile per Customer — the hot lookup path (resolve-or-create on every payment
// touchpoint: SetupIntent creation, activation charge, off-session cancellation/no-show charge).
customerPaymentProfileSchema.index({ userId: 1 }, { unique: true });
// Reverse lookup for webhook reconciliation (a Stripe event carries a Customer id, never our
// own userId).
customerPaymentProfileSchema.index({ stripeCustomerId: 1 }, { unique: true });

export const CustomerPaymentProfileModel = model<CustomerPaymentProfileDocument>(
  "CustomerPaymentProfile",
  customerPaymentProfileSchema,
);
