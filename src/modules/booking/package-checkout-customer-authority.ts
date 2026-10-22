import { randomBytes } from "node:crypto";
import { mongo, Types } from "mongoose";
import type { TokenService } from "../auth/token.service.js";
import type { UserRepository } from "../user/user.repository.js";
import {
  assertPackageAccepted,
  assertPackagePresentation,
  type PackageCheckoutAccepted,
  type PackageCheckoutPresentation,
  packageCheckoutAffirmativeActionSchema,
} from "./package-checkout-acceptance.js";
import { assertPackageCheckoutCurrent } from "./package-checkout-binding.js";
import {
  buildPackageCheckoutDisclosure,
  PACKAGE_DISCLOSURE_TEMPLATE_ID,
} from "./package-checkout-disclosure.js";
import {
  type PackageCheckoutRetention,
  packageCheckoutRetentionSchema,
} from "./package-checkout-retention.js";

// Runtime capabilities, not structurally trusted DTOs. No exported constructor or test bypass.
declare const customerBrand: unique symbol;
export type PackageCheckoutCustomer = { readonly [customerBrand]: true };
declare const grantBrand: unique symbol;
export type PackageCheckoutClaimGrant = { readonly [grantBrand]: true };
const customers = new WeakMap<object, { userId: Types.ObjectId; sessionFamilyId: string }>();
const grants = new WeakMap<
  object,
  { retention: PackageCheckoutRetention } & (
    | { kind: "PRESENT"; presentation: PackageCheckoutPresentation }
    | {
        kind: "ACCEPT";
        presentation: PackageCheckoutPresentation;
        accepted: PackageCheckoutAccepted;
      }
  )
>();
const grantChecks = new WeakMap<object, () => void>();
const copy = <T>(value: T): T => mongo.BSON.deserialize(mongo.BSON.serialize(value as object)) as T;
export const readPackageCheckoutCustomer = (proof: PackageCheckoutCustomer) => {
  const customer = customers.get(proof);
  if (!customer) throw new Error("Verified Customer capability required");
  return { ...customer, userId: new Types.ObjectId(customer.userId.toHexString()) };
};
export const readPackageCheckoutClaimGrant = (grant: PackageCheckoutClaimGrant) => {
  const authorized = grants.get(grant);
  if (!authorized) throw new Error("Verified checkout transition capability required");
  grantChecks.get(grant)?.();
  grants.delete(grant);
  grantChecks.delete(grant);
  return copy(authorized);
};

/** Verifies the same token, live session and current user authorities as access middleware.
 * Stricter for new consent: a sid-bound ACTIVE Customer is mandatory; no legacy-token grace.
 * Bearer only: refresh cookies and posted actor/status/session fields are never credentials.
 */
export class PackageCheckoutCustomerAuthority {
  public constructor(
    private readonly tokens: Pick<TokenService, "verifyAccessToken" | "isAccessTokenSessionLive">,
    private readonly users: Pick<UserRepository, "findById">,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async authenticate(authorization: string | undefined): Promise<PackageCheckoutCustomer> {
    if (!authorization?.startsWith("Bearer "))
      throw new Error("Customer Bearer authentication required");
    const claims = await this.tokens.verifyAccessToken(authorization.slice(7));
    if (!claims.sid || claims.role !== "CUSTOMER")
      throw new Error("Session-bound Customer required");
    const [user, live] = await Promise.all([
      this.users.findById(claims.sub),
      this.tokens.isAccessTokenSessionLive(claims),
    ]);
    if (
      !live ||
      !user ||
      user.role !== "CUSTOMER" ||
      user.status !== "ACTIVE" ||
      String(user._id) !== claims.sub
    )
      throw new Error("Active Customer session required");
    const proof = Object.freeze({}) as PackageCheckoutCustomer;
    customers.set(proof, { userId: new Types.ObjectId(claims.sub), sessionFamilyId: claims.sid });
    return proof;
  }

  public present(
    customerProof: PackageCheckoutCustomer,
    retainedInput: unknown,
    freshQuote: unknown,
    providers: unknown,
  ): PackageCheckoutClaimGrant {
    const customer = readPackageCheckoutCustomer(customerProof);
    const retention = packageCheckoutRetentionSchema.parse(retainedInput);
    const now = new Date(this.clock().getTime());
    if (!retention.seed.customerUserId.equals(customer.userId))
      throw new Error("Foreign checkout Customer");
    assertPackageCheckoutCurrent(retention.quote, freshQuote, now);
    const presentation = assertPackagePresentation(retention, {
      version: 1,
      presentationId: new Types.ObjectId(),
      customerUserId: customer.userId,
      sessionFamilyId: customer.sessionFamilyId,
      presentedAt: now,
      challenge: randomBytes(32).toString("hex"),
      disclosure: buildPackageCheckoutDisclosure(retention, new Types.ObjectId(), providers),
    });
    const grant = Object.freeze({}) as PackageCheckoutClaimGrant;
    customers.delete(customerProof);
    grants.set(grant, copy({ kind: "PRESENT", retention, presentation }));
    grantChecks.set(grant, () =>
      assertPackageCheckoutCurrent(retention.quote, freshQuote, new Date(this.clock().getTime())),
    );
    return grant;
  }

  public accept(
    customerProof: PackageCheckoutCustomer,
    retainedInput: unknown,
    presentationInput: unknown,
    freshQuote: unknown,
    actionInput: unknown,
  ): PackageCheckoutClaimGrant {
    const customer = readPackageCheckoutCustomer(customerProof);
    const retention = packageCheckoutRetentionSchema.parse(retainedInput);
    const presentation = assertPackagePresentation(retention, presentationInput);
    if (
      !presentation.customerUserId.equals(customer.userId) ||
      presentation.sessionFamilyId !== customer.sessionFamilyId
    )
      throw new Error("Disclosure presentation belongs to another Customer/session");
    const event = packageCheckoutAffirmativeActionSchema.parse(actionInput);
    const acceptedAt = new Date(this.clock().getTime());
    assertPackageCheckoutCurrent(retention.quote, freshQuote, acceptedAt);
    const q = retention.quote.payload;
    const accepted = assertPackageAccepted(retention, presentation, {
      version: 1,
      state: "ACCEPTED_IMMUTABLE",
      event,
      sessionFamilyId: customer.sessionFamilyId,
      disclosurePayloadId: presentation.disclosure.content.payloadId,
      disclosureHash: presentation.disclosure.contentHash,
      evidence: {
        version: 1,
        contractVersion: 1,
        scope: "PURCHASE",
        acceptanceId: new Types.ObjectId(),
        acceptedTermsPayloadId: q.quoteId,
        acceptedTermsHash: retention.quote.termsHash,
        templateId: new Types.ObjectId(PACKAGE_DISCLOSURE_TEMPLATE_ID),
        templateVersion: 1,
        actorUserId: customer.userId,
        customerUserId: customer.userId,
        actorRole: "CUSTOMER",
        acceptedAt,
        businessId: q.businessId,
        packageId: q.packageId,
        packageRevision: q.definitionRevision,
        packageProgressId: q.packageProgressId,
        batchId: q.batchId,
        quoteId: q.quoteId,
        provenance: "CUSTOMER_ACCEPTANCE_RECORD",
        items: q.items.map(({ packageItemId, definitionItemId, serviceId }) => ({
          packageItemId,
          definitionItemId,
          serviceId,
        })),
      },
    });
    const grant = Object.freeze({}) as PackageCheckoutClaimGrant;
    customers.delete(customerProof);
    grants.set(grant, copy({ kind: "ACCEPT", retention, presentation, accepted }));
    grantChecks.set(grant, () =>
      assertPackageCheckoutCurrent(retention.quote, freshQuote, new Date(this.clock().getTime())),
    );
    return grant;
  }
}
