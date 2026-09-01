import { logger } from "../../config/logger.js";
import type { UserRepository } from "../user/user.repository.js";
import { verifyMarketingUnsubscribeToken } from "./marketing-unsubscribe.token.js";

/**
 * Marketing Email Stage M2 — the one operation behind the public unsubscribe endpoint.
 *
 * Contract:
 *  - a valid token → the linked account's `UserProfile.notifications.marketingEmail` is set to
 *    `false` (sibling-safe dot-path `$set` via the shared `UserRepository.updateProfile`);
 *  - it is idempotent — already `false`, or no `UserProfile` at all, both resolve as success;
 *  - it is one-way — this path can ONLY ever write `false`, never `true`, and touches no other
 *    field (name, language, reminder channels, account status, email, …);
 *  - only an unusable token fails, and it fails generically (see MarketingError) — the caller
 *    can never tell whether an account/profile/preference existed.
 */
export class MarketingUnsubscribeService {
  public constructor(private readonly userRepository: UserRepository) {}

  public async unsubscribe(token: string): Promise<void> {
    const { userId } = await verifyMarketingUnsubscribeToken(token);

    const profile = await this.userRepository.findProfileByUserId(userId);
    if (profile) {
      await this.userRepository.updateProfile(profile._id, {
        notifications: { marketingEmail: false },
        // Stage M3A — audit provenance. Same sibling-safe write; still one-way (only ever `false`).
        marketingEmailConsent: { updatedAt: new Date(), source: "unsubscribe" },
      });
    }

    // Safe fields only — no token, no email, no name, no userId (not needed to operate).
    logger.info(
      { operation: "marketing_unsubscribe", result: "ok" },
      "Marketing unsubscribe processed",
    );
  }
}
