import type { TokenService } from "../auth/token.service.js";
import type { UserRepository } from "../user/user.repository.js";
import { batchConflict } from "./package-batch-contract.js";
import { PackageCalendarWriteAuthorityUnavailableError } from "./package-calendar-delivery.js";

declare const calendarOwnerBrand: unique symbol;
export type PackageCalendarOwner = { readonly [calendarOwnerBrand]: true };
const ownerChecks = new WeakMap<
  object,
  () => Promise<{ userId: string; sessionFamilyId: string }>
>();

/** A posted Owner ID is not authorization. Reuse verified Bearer tokens, current users and
 * live sid-bound sessions, issuing only a process-local capability that cannot be forged as JSON.
 * Every release/recovery revalidates it. No token is stored in the delivery journal. */
export class PackageCalendarOwnerAuthority {
  constructor(
    private readonly tokens: Pick<TokenService, "verifyAccessToken" | "isAccessTokenSessionLive">,
    private readonly users: Pick<UserRepository, "findById">,
  ) {}
  async authenticate(authorization: string | undefined): Promise<PackageCalendarOwner> {
    if (!authorization?.startsWith("Bearer ")) throw batchConflict();
    const token = authorization.slice(7);
    const initial = await this.tokens.verifyAccessToken(token);
    if (!initial.sid || initial.role !== "BUSINESS_OWNER") throw batchConflict();
    const check = async () => {
      const claims = await this.tokens.verifyAccessToken(token);
      if (
        claims.sub !== initial.sub ||
        claims.sid !== initial.sid ||
        claims.role !== "BUSINESS_OWNER"
      )
        throw batchConflict();
      const [user, live] = await Promise.all([
        this.users.findById(claims.sub),
        this.tokens.isAccessTokenSessionLive(claims),
      ]);
      if (
        !live ||
        !user ||
        user.role !== "BUSINESS_OWNER" ||
        user.status !== "ACTIVE" ||
        String(user._id) !== claims.sub ||
        !claims.sid
      )
        throw batchConflict();
      return { userId: claims.sub, sessionFamilyId: claims.sid };
    };
    await check();
    const proof = Object.freeze({}) as PackageCalendarOwner;
    ownerChecks.set(proof, check);
    return proof;
  }
}
export async function readVerifiedCalendarOwner(proof: PackageCalendarOwner) {
  const check = ownerChecks.get(proof);
  if (!check) throw batchConflict();
  return check();
}

/** Separate production rollout authority, default denied. No environment flag, caller boolean,
 * HTTP route or grant factory can enable it. Trusted engineering tests mock this module only.
 * Activation review must approve credentials/scopes, release policy and uncertain-write runbook
 * before this authority is replaced. The full implementation behind it does not depend on 503. */
export async function verifyPackageCalendarProductionAuthority(): Promise<void> {
  throw new PackageCalendarWriteAuthorityUnavailableError();
}
