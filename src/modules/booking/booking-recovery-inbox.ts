import { mongo, Types } from "mongoose";
import { z } from "zod";
import { AppError } from "../../common/errors/app-error.js";
import { BusinessModel } from "../business/business.model.js";
import { PaymentAttemptModel } from "../payment/payment-attempt.model.js";
import type { BookingCreationService } from "./booking-creation.service.js";
import { BookingCreationClaimModel } from "./booking-creation-claim.model.js";

const cursorSchema = z
  .object({
    version: z.literal(1),
    customerId: z.string().regex(/^[a-f\d]{24}$/),
    createdAt: z.iso.datetime(),
    id: z.string().regex(/^[a-f\d]{24}$/),
    source: z.enum(["ATTEMPT", "CLAIM"]),
  })
  .strict();
type Candidate = {
  id: Types.ObjectId;
  createdAt: Date;
  source: "ATTEMPT" | "CLAIM";
  businessId: Types.ObjectId;
  key: string;
};
export function decodeRecoveryCursor(raw: string | undefined, customerId: string) {
  if (!raw) return undefined;
  try {
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (cursor.customerId !== customerId) throw Error("scope");
    return cursor;
  } catch {
    throw new AppError("Invalid Booking recovery cursor", 400);
  }
}
function olderThan(cursor: ReturnType<typeof decodeRecoveryCursor>, source: Candidate["source"]) {
  if (!cursor) return {};
  const createdAt = new Date(cursor.createdAt),
    id = new Types.ObjectId(cursor.id);
  return {
    $or: [
      { createdAt: { $lt: createdAt } },
      { createdAt, _id: source < cursor.source ? { $lte: id } : { $lt: id } },
    ],
  };
}

/** Bounded evidence pages, not an alternate payment authority. Every emitted status is read
 * through P4A. Terminal/duplicate candidates still advance the cursor, so a page can be empty.
 * No checkout body is stored in these models; no cross-device replay is fabricated. */
export class BookingRecoveryInbox {
  constructor(
    private readonly status: Pick<BookingCreationService, "readCustomerBookingPayment">,
  ) {}
  async list(customerId: string, limit: number, rawCursor?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new AppError("Invalid recovery page size", 400);
    const customer = new Types.ObjectId(customerId),
      cursor = decodeRecoveryCursor(rawCursor, String(customer));
    try {
      const [attempts, claims] = await Promise.all([
        PaymentAttemptModel.find({
          customerUserId: customer,
          productKind: "NORMAL_BOOKING",
          purpose: "BOOKING_DEPOSIT",
          createdAt: { $type: "date" },
          businessId: { $type: "objectId" },
          packageBatchBinding: { $exists: false },
          packageLifecycleBinding: { $exists: false },
          ...olderThan(cursor, "ATTEMPT"),
        })
          .select("_id createdAt businessId logicalIdempotencyKey")
          .sort({ createdAt: -1, _id: -1 })
          .limit(limit + 1)
          .hint({ customerUserId: 1, productKind: 1, purpose: 1, createdAt: -1, _id: -1 })
          .read("primary")
          .readConcern("majority")
          .maxTimeMS(2000)
          .lean(),
        BookingCreationClaimModel.find({
          actorUserId: customer,
          "financialContract.productKind": "NORMAL_BOOKING",
          createdAt: { $type: "date" },
          packageRequestBinding: { $exists: false },
          packageCheckoutRetention: { $exists: false },
          packageCheckoutPresentation: { $exists: false },
          packageCheckoutAcceptance: { $exists: false },
          ...olderThan(cursor, "CLAIM"),
        })
          .select("_id createdAt businessId idempotencyKey")
          .sort({ createdAt: -1, _id: -1 })
          .limit(limit + 1)
          .hint({ actorUserId: 1, "financialContract.productKind": 1, createdAt: -1, _id: -1 })
          .read("primary")
          .readConcern("majority")
          .maxTimeMS(2000)
          .lean(),
      ]);
      const candidates: Candidate[] = [
        ...attempts.map((a) => ({
          id: a._id,
          createdAt: a.createdAt,
          businessId: a.businessId!,
          key: a.logicalIdempotencyKey,
          source: "ATTEMPT" as const,
        })),
        ...claims.map((c) => ({
          id: c._id,
          createdAt: c.createdAt,
          businessId: c.businessId,
          key: c.idempotencyKey,
          source: "CLAIM" as const,
        })),
      ].sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          String(b.id).localeCompare(String(a.id)) ||
          b.source.localeCompare(a.source),
      );
      const page = candidates.slice(0, limit),
        hasMore = candidates.length > limit;
      // Suppress a paid claim's duplicate even when its attempt falls on another page.
      // The existing unique logical-key index bounds this lookup to at most `limit` keys.
      const paid = await PaymentAttemptModel.find({
        customerUserId: customer,
        productKind: "NORMAL_BOOKING",
        purpose: "BOOKING_DEPOSIT",
        createdAt: { $type: "date" },
        logicalIdempotencyKey: { $in: page.filter((c) => c.source === "CLAIM").map((c) => c.key) },
        packageBatchBinding: { $exists: false },
        packageLifecycleBinding: { $exists: false },
      })
        .select("businessId logicalIdempotencyKey")
        .read("primary")
        .readConcern("majority")
        .maxTimeMS(2000)
        .lean();
      const businesses = await BusinessModel.find({ _id: { $in: page.map((c) => c.businessId) } })
        .select("name")
        .read("primary")
        .readConcern("majority")
        .maxTimeMS(2000)
        .lean();
      const items = [];
      for (const c of page) {
        if (!c.key || c.key.length > 200) continue; // Unsupported legacy key, never a fabricated replay.
        if (
          c.source === "CLAIM" &&
          paid.some((a) => a.logicalIdempotencyKey === c.key && a.businessId?.equals(c.businessId))
        )
          continue;
        try {
          const checked = await this.status.readCustomerBookingPayment(
            customerId,
            String(c.businessId),
            c.key,
          );
          // Explicit DTO: never copy a secret, contract, ledger, raw claim or provider metadata.
          items.push({
            businessId: String(c.businessId),
            idempotencyKey: c.key,
            businessName: businesses.find((b) => b._id.equals(c.businessId))?.name,
            status: {
              state: checked.state,
              businessId: checked.businessId,
              idempotencyKey: checked.idempotencyKey,
              canDismiss: checked.canDismiss,
              canResume: false,
              ...(checked.resumeBlockedReason
                ? { resumeBlockedReason: checked.resumeBlockedReason }
                : {}),
              ...(checked.state === "COMMITTED" && checked.bookingId
                ? { bookingId: checked.bookingId, reference: checked.reference }
                : {}),
            },
            nextAction: "CHECK_STATUS" as const,
            replayAvailable: false as const,
          });
        } catch (error) {
          // Invalid/foreign/unsupported binding is not an ordinary operation to disclose.
          // Storage failures remain outages, never silently empty history.
          if (error instanceof AppError && [404, 409].includes(error.statusCode)) continue;
          throw error;
        }
      }
      const resolved = items.filter((i) => i.status.canDismiss);
      const requests = items.filter((i) => !i.status.canDismiss);
      const last = page.at(-1);
      const nextCursor =
        hasMore && last
          ? Buffer.from(
              JSON.stringify({
                version: 1,
                customerId: String(customer),
                createdAt: last.createdAt.toISOString(),
                id: String(last.id),
                source: last.source,
              }),
            ).toString("base64url")
          : undefined;
      return {
        requests,
        resolved,
        hasMore,
        scanned: page.length,
        ...(nextCursor ? { nextCursor } : {}),
      };
    } catch (error) {
      if (error instanceof mongo.MongoError)
        throw new AppError("Booking recovery history is temporarily unavailable", 503);
      throw error;
    }
  }
}
