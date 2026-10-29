import { Types } from "mongoose";
import { z } from "zod";
import { lifecycleIntentSchema } from "./package-lifecycle-operation.js";

export const lifecycleHttpId = z
  .string()
  .regex(/^[a-fA-F0-9]{24}$/)
  .transform((s) => new Types.ObjectId(s));
const instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
export const lifecycleHttpActions = [
  "redeem",
  "reschedule",
  "cancel",
  "complete",
  "mark-no-show",
  "no-show",
  "reverse-no-show",
  "expire",
  "settlement",
  "session-quote",
  "session-acceptance",
  "session-status",
  "cancel-status",
  "reschedule-status",
  "expire-status",
  "complete-status",
  "mark-no-show-status",
  "no-show-status",
  "reverse-no-show-status",
  "settlement-status",
  "selection",
] as const;
// Actor, Customer and BusinessClient identities are resolved by the controller, never posted.
const scope = z
  .object({ businessId: lifecycleHttpId, packageProgressId: lifecycleHttpId })
  .strict();
const operation = scope.extend({ key: lifecycleIntentSchema.shape.key });
const redemption = operation.extend({
  packageItemId: lifecycleHttpId,
  staffMembershipId: lifecycleHttpId,
  startAt: instant,
  dues: lifecycleIntentSchema.shape.dues
    .unwrap()
    .extend({ addonIds: z.array(lifecycleHttpId).max(50) })
    .optional(),
});
export const lifecycleHttpAcceptance = z
  .object({
    quoteId: lifecycleHttpId,
    termsHash: z.string().regex(/^[a-f0-9]{64}$/),
    disclosureHash: z.string().regex(/^[a-f0-9]{64}$/),
    challenge: z.string().min(32),
    action: z.literal("ACCEPT_SESSION_DUES"),
  })
  .strict();
export const lifecycleHttpSchemas = {
  redeem: redemption,
  "session-quote": redemption.required({ dues: true }),
  "session-acceptance": redemption
    .required({ dues: true })
    .extend({ acceptance: lifecycleHttpAcceptance }),
  // Read-only recovery: the exact retained redemption request (same key and fields).
  "session-status": redemption,
  reschedule: operation.extend({ bookingId: lifecycleHttpId, startAt: instant }),
  cancel: operation.extend({ bookingId: lifecycleHttpId }),
  complete: operation.extend({
    bookingId: lifecycleHttpId,
    venuePayment: lifecycleIntentSchema.shape.venuePayment,
  }),
  "mark-no-show": operation.extend({ bookingId: lifecycleHttpId }),
  "no-show": operation.extend({ bookingId: lifecycleHttpId }),
  "reverse-no-show": operation.extend({ bookingId: lifecycleHttpId }),
  expire: operation,
  // Read-only recovery of the exact retained Customer request; same wire shape as its action.
  "cancel-status": operation.extend({ bookingId: lifecycleHttpId }),
  "reschedule-status": operation.extend({ bookingId: lifecycleHttpId, startAt: instant }),
  "expire-status": operation,
  // P4K-5 management recovery (Owner/Supervisor): same wire shape as each management action.
  "complete-status": operation.extend({
    bookingId: lifecycleHttpId,
    venuePayment: lifecycleIntentSchema.shape.venuePayment,
  }),
  "mark-no-show-status": operation.extend({ bookingId: lifecycleHttpId }),
  "no-show-status": operation.extend({ bookingId: lifecycleHttpId }),
  "reverse-no-show-status": operation.extend({ bookingId: lifecycleHttpId }),
  "settlement-status": operation.extend({
    bookingId: lifecycleHttpId,
    venuePayment: lifecycleIntentSchema.shape.venuePayment.unwrap(),
  }),
  settlement: operation.extend({
    bookingId: lifecycleHttpId,
    venuePayment: lifecycleIntentSchema.shape.venuePayment.unwrap(),
  }),
  selection: scope.extend({
    packageItemId: lifecycleHttpId,
    fromDate: z.iso.date(),
    toDate: z.iso.date(),
    staffMembershipId: lifecycleHttpId.optional(),
    travelAddress: lifecycleIntentSchema.shape.dues.unwrap().shape.travelAddress,
  }),
} as const;
export type LifecycleHttpAction = (typeof lifecycleHttpActions)[number];
/** Read-only status actions and the one lifecycle action each may observe. */
export const lifecycleStatusActions = {
  "session-status": "REDEEM",
  "cancel-status": "CANCEL",
  "reschedule-status": "RESCHEDULE",
  "expire-status": "EXPIRE",
  "complete-status": "COMPLETE",
  "mark-no-show-status": "MARK_NO_SHOW",
  "no-show-status": "NO_SHOW",
  "reverse-no-show-status": "REVERSE_NO_SHOW",
  "settlement-status": "VENUE_SETTLEMENT",
} as const satisfies Partial<Record<LifecycleHttpAction, string>>;
