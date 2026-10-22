import { Types } from "mongoose";
import type { PackageRepository } from "../packages/package.repository.js";
import type { BookingCreationClaimRepository } from "./booking-creation-claim.repository.js";
import { assertPackageCheckoutCurrent } from "./package-checkout-binding.js";
import { packageCheckoutSeedSchema } from "./package-checkout-contract.js";
import type { PackageCheckoutQuotePreparer } from "./package-checkout-quote.service.js";
import {
  normalizePackageCheckoutIntent,
  packageCheckoutRetentionSchema,
} from "./package-checkout-retention.js";

type Context = Parameters<PackageCheckoutQuotePreparer["prepare"]>[0];

/** INTERNAL / UNWIRED. The caller supplies authenticated context, never a posted actor.
 * Lifetime is an explicit server composition decision; no production lifetime is invented.
 * No acceptance, relationship, provider or Booking write is reachable here.
 */
export class PackageCheckoutRetentionService {
  public constructor(
    private readonly claims: Pick<
      BookingCreationClaimRepository,
      "findRetainedPackageCheckout" | "retainPackageCheckout"
    >,
    private readonly packages: Pick<PackageRepository, "findById">,
    private readonly preparer: Pick<PackageCheckoutQuotePreparer, "prepare">,
    private readonly quoteLifetimeMs: number,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (!Number.isSafeInteger(quoteLifetimeMs) || quoteLifetimeMs <= 0)
      throw new Error("Explicit server quote lifetime required");
  }

  public async prepareAndRetain(context: Context, operationKey: string, input: unknown) {
    if (context.role !== "CUSTOMER" || !context.actorUserId.equals(context.customerUserId))
      throw new Error("Authenticated Customer required");
    const intent = normalizePackageCheckoutIntent(input);
    const idempotencyKey = operationKey.trim();
    if (!idempotencyKey || idempotencyKey.length > 200) throw new Error("Invalid operation key");
    const scope = {
      idempotencyKey,
      businessId: context.businessId,
      actorUserId: context.actorUserId,
      intent,
    };
    const existing = await this.claims.findRetainedPackageCheckout(scope);
    if (existing) return this.verifyCurrent(context, existing);
    const definition = await this.packages.findById(
      context.businessId,
      intent.packageId.toHexString(),
    );
    if (
      !definition?.businessId.equals(context.businessId) ||
      definition.revision !== intent.expectedRevision ||
      definition.status !== "ACTIVE"
    )
      throw new Error("Package offer unavailable or stale");
    const issuedAt = new Date(this.clock().getTime());
    const seed = packageCheckoutSeedSchema.parse({
      version: 1,
      quoteId: new Types.ObjectId(),
      batchId: new Types.ObjectId(),
      packageProgressId: new Types.ObjectId(),
      temporalProofRef: new Types.ObjectId(),
      idempotencyKey,
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + this.quoteLifetimeMs),
      businessId: context.businessId,
      customerUserId: context.customerUserId,
      actorUserId: context.actorUserId,
      actorRole: "CUSTOMER",
      items: definition.items.map((item) => ({
        definitionItemId: item.itemId,
        packageItemId: new Types.ObjectId(),
      })),
      appointments: intent.selections.map((row) => ({
        selectionId: row.selectionId,
        bookingId: new Types.ObjectId(),
      })),
    });
    const quote = await this.preparer.prepare(context, intent, seed);
    const retained = await this.claims.retainPackageCheckout({
      version: 1,
      state: "INTERNAL_RETAINED_NOT_ACCEPTED",
      seed,
      intent,
      quote,
    });
    // Also verify a concurrent winner. Never return a losing proposal as the stored quote.
    return this.verifyCurrent(context, retained);
  }

  private async verifyCurrent(context: Context, input: unknown) {
    const retained = packageCheckoutRetentionSchema.parse(input);
    const fresh = await this.preparer.prepare(context, retained.intent, retained.seed);
    assertPackageCheckoutCurrent(retained.quote, fresh, new Date(this.clock().getTime()));
    return retained;
  }
}
