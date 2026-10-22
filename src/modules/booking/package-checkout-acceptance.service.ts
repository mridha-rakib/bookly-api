import { isDeepStrictEqual } from "node:util";
import { Types } from "mongoose";
import type { StaffRepository } from "../staff/staff.repository.js";
import type { UserRepository } from "../user/user.repository.js";
import type { BookingCreationClaimRepository } from "./booking-creation-claim.repository.js";
import { packageCheckoutAffirmativeActionSchema } from "./package-checkout-acceptance.js";
import { assertPackageCheckoutCurrent } from "./package-checkout-binding.js";
import {
  type PackageCheckoutCustomer,
  type PackageCheckoutCustomerAuthority,
  readPackageCheckoutCustomer,
} from "./package-checkout-customer-authority.js";
import { buildPackageCheckoutDisclosure } from "./package-checkout-disclosure.js";
import type { PackageCheckoutQuotePreparer } from "./package-checkout-quote.service.js";
import type { PackageCheckoutRetention } from "./package-checkout-retention.js";

/** INTERNAL / NOT REGISTERED. A future authenticated UI must deliver the returned exact
 * disclosure as text with an unchecked acceptance control, then post its explicit action.
 * These methods verify Bearer credentials themselves; no req.auth/evidence DTO grants consent.
 * The server-side protocol is testable now; genuine UI interaction is NOT WIRED.
 */
export class PackageCheckoutAcceptanceService {
  public constructor(
    private readonly claims: Pick<
      BookingCreationClaimRepository,
      "findPackageCheckoutForCustomer" | "commitPackageCheckoutGrant"
    >,
    private readonly authority: PackageCheckoutCustomerAuthority,
    private readonly preparer: Pick<PackageCheckoutQuotePreparer, "prepare">,
    private readonly staff: Pick<StaffRepository, "findManyByIdsForBusiness">,
    private readonly users: Pick<UserRepository, "findProfilesByUserIds">,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async names(retained: PackageCheckoutRetention) {
    const ids = [
      ...new Set(
        retained.quote.payload.appointments.map((row) => row.staffMembershipId.toHexString()),
      ),
    ].map((id) => new Types.ObjectId(id));
    const staff = await this.staff.findManyByIdsForBusiness(retained.seed.businessId, ids);
    if (
      staff.length !== ids.length ||
      staff.some(
        (row) =>
          !row.businessId.equals(retained.seed.businessId) ||
          !row.employmentActive ||
          row.removedAt,
      )
    )
      throw new Error("Selected staff context unavailable");
    const profiles = await this.users.findProfilesByUserIds(staff.map((row) => row.userId));
    return ids.map((id) => {
      const member = staff.find((row) => row._id.equals(id));
      const profile = profiles.find((row) => row.userId.equals(member?.userId));
      if (!profile) throw new Error("Selected staff display name unavailable");
      return {
        staffMembershipId: id,
        displayName: `${profile.firstName} ${profile.lastName}`.trim(),
      };
    });
  }

  private async fresh(customer: PackageCheckoutCustomer, retained: PackageCheckoutRetention) {
    const owner = readPackageCheckoutCustomer(customer);
    const quote = await this.preparer.prepare(
      {
        businessId: retained.seed.businessId,
        customerUserId: owner.userId,
        actorUserId: owner.userId,
        role: "CUSTOMER",
      },
      retained.intent,
      retained.seed,
    );
    assertPackageCheckoutCurrent(retained.quote, quote, new Date(this.clock().getTime()));
    return quote;
  }

  public async present(
    authorization: string | undefined,
    businessId: Types.ObjectId,
    operationKey: string,
  ) {
    const customer = await this.authority.authenticate(authorization);
    const row = await this.claims.findPackageCheckoutForCustomer(
      customer,
      businessId,
      operationKey,
    );
    const owner = readPackageCheckoutCustomer(customer);
    if (row.presentation) {
      if (!row.accepted && row.presentation.sessionFamilyId !== owner.sessionFamilyId)
        throw new Error("Presentation is bound to another session; new checkout required");
      if (!row.accepted) {
        await this.fresh(customer, row.retention);
        const disclosure = buildPackageCheckoutDisclosure(
          row.retention,
          row.presentation.disclosure.content.payloadId,
          await this.names(row.retention),
        );
        if (disclosure.contentHash !== row.presentation.disclosure.contentHash)
          throw new Error("Disclosure facts changed; new quote required");
      }
      return row.presentation;
    }
    const fresh = await this.fresh(customer, row.retention);
    const names = await this.names(row.retention);
    const grant = this.authority.present(
      await this.authority.authenticate(authorization),
      row.retention,
      fresh,
      names,
    );
    await this.claims.commitPackageCheckoutGrant(grant);
    const winner = await this.claims.findPackageCheckoutForCustomer(
      customer,
      businessId,
      operationKey,
    );
    if (!winner.presentation || winner.presentation.sessionFamilyId !== owner.sessionFamilyId)
      throw new Error("Concurrent presentation/session conflict");
    return winner.presentation;
  }

  public async accept(
    authorization: string | undefined,
    businessId: Types.ObjectId,
    operationKey: string,
    actionInput: unknown,
  ) {
    const customer = await this.authority.authenticate(authorization);
    const action = packageCheckoutAffirmativeActionSchema.parse(actionInput);
    const row = await this.claims.findPackageCheckoutForCustomer(
      customer,
      businessId,
      operationKey,
    );
    // Committed matching replay precedes stale reads. Identity/time/evidence never regenerate.
    if (row.accepted) {
      if (!isDeepStrictEqual(row.accepted.event, action))
        throw new Error("Conflicting acceptance event");
      return row.accepted;
    }
    if (
      !row.presentation ||
      row.presentation.sessionFamilyId !== readPackageCheckoutCustomer(customer).sessionFamilyId
    )
      throw new Error("Owned session-bound disclosure presentation required");
    const fresh = await this.fresh(customer, row.retention);
    const disclosure = buildPackageCheckoutDisclosure(
      row.retention,
      row.presentation.disclosure.content.payloadId,
      await this.names(row.retention),
    );
    if (disclosure.contentHash !== row.presentation.disclosure.contentHash)
      throw new Error("Disclosure facts changed; new quote required");
    const grant = this.authority.accept(
      await this.authority.authenticate(authorization),
      row.retention,
      row.presentation,
      fresh,
      action,
    );
    await this.claims.commitPackageCheckoutGrant(grant);
    const winner = await this.claims.findPackageCheckoutForCustomer(
      customer,
      businessId,
      operationKey,
    );
    if (!winner.accepted || !isDeepStrictEqual(winner.accepted.event, action))
      throw new Error("Concurrent acceptance conflict");
    return winner.accepted;
  }
}
