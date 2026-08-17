import type { Types } from "mongoose";

import type { UserRepository } from "../user/user.repository.js";
import type { ClientRepository } from "./client.repository.js";
import type { ClientLinkState } from "./client.types.js";

export type ContactLinkResolution = {
  linkState: ClientLinkState;
  linkedUserId?: Types.ObjectId | undefined;
};

/**
 * Shared identity-matching rules for Client <-> Customer linking. "Verified" always means a
 * CUSTOMER User row with emailVerifiedAt/phoneVerifiedAt already set — Bookly's customer
 * signup flow requires both OTP steps before a CUSTOMER account exists, so every CUSTOMER is
 * fully verified by construction (see auth.service.ts completeCustomer).
 *
 * Both entry points below share one rule: link ONLY when email and phone both resolve to the
 * SAME verified Customer. Any partial or crossed match is IDENTITY_CONFLICT — never a guess,
 * never a "closest match".
 */
export class ClientIdentityService {
  public constructor(
    private readonly userRepository: UserRepository,
    private readonly clientRepository: ClientRepository,
  ) {}

  /** Used when a Business creates a new Client — checks if it already matches a real Customer. */
  public async resolveContactLinkState(contact: {
    normalizedEmail: string;
    phoneE164: string;
  }): Promise<ContactLinkResolution> {
    const [userByEmail, userByPhone] = await Promise.all([
      this.userRepository.findVerifiedCustomerByEmail(contact.normalizedEmail),
      this.userRepository.findVerifiedCustomerByPhoneE164(contact.phoneE164),
    ]);

    if (userByEmail && userByPhone && userByEmail._id.equals(userByPhone._id)) {
      return { linkState: "LINKED", linkedUserId: userByEmail._id };
    }

    if (userByEmail || userByPhone) {
      return { linkState: "IDENTITY_CONFLICT" };
    }

    return { linkState: "UNLINKED" };
  }

  /**
   * Called after a Customer finishes self-registration — scans every Business's UNLINKED
   * Client rows for a match to this brand-new verified identity. Runs across ALL businesses
   * (one Customer may legitimately be a Client of many). Never touches archivedAt — an
   * archived Client may link without being restored; only the owning Business restores it.
   * Best-effort: the caller is responsible for logging and swallowing failures, never for
   * letting this block registration.
   */
  public async linkEligibleClientsForNewCustomer(customer: {
    userId: Types.ObjectId;
    normalizedEmail: string;
    phoneE164: string;
  }): Promise<void> {
    const [emailMatches, phoneMatches] = await Promise.all([
      this.clientRepository.findUnlinkedByEmail(customer.normalizedEmail),
      this.clientRepository.findUnlinkedByPhoneE164(customer.phoneE164),
    ]);

    const phoneMatchIds = new Set(phoneMatches.map((client) => String(client._id)));
    const candidateIds = new Set([
      ...emailMatches.map((client) => String(client._id)),
      ...phoneMatchIds,
    ]);

    await Promise.all(
      [...candidateIds].map((id) => {
        const matchesBoth = phoneMatchIds.has(id) && emailMatches.some((c) => String(c._id) === id);

        return matchesBoth
          ? this.clientRepository.setLinkState(id, {
              linkState: "LINKED",
              linkedUserId: customer.userId,
            })
          : this.clientRepository.setLinkState(id, { linkState: "IDENTITY_CONFLICT" });
      }),
    );
  }
}
