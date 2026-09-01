import type { Types } from "mongoose";

import { logger } from "../../config/logger.js";
import type { UserRepository } from "../user/user.repository.js";
import type { MarketingCampaignRecipientRepository } from "./marketing-campaign-recipient.repository.js";

/** How many opted-in profiles to pull per cursor page. */
const AUDIENCE_SCAN_PAGE_SIZE = 1000;

export type MaterializeResult = { audienceCount: number };

/**
 * Marketing Email Stage M3A — audience materialization for `audience.scope === "ALL_OPTED_IN"`.
 *
 * Turns "every platform customer who has explicitly opted in" into `MarketingCampaignRecipient`
 * rows (`status: PENDING`). Streams the audience with `_id`-cursor pagination (never loads the
 * customer base into memory, never `skip`/`offset`), batch-loads `User` rows per page (no N+1),
 * and applies the send-independent eligibility filter:
 *
 *   role === "CUSTOMER"  &&  status === "ACTIVE"  &&  emailVerifiedAt set  &&  usable email
 *
 * Opted-out / legacy-missing-field / SUSPENDED / DORMANT / unverified / non-CUSTOMER / manual
 * (unlinked) contacts never produce a row. Idempotent: the unique `{campaignId, userId}` index
 * means a crash-and-resume, or a re-run, adds only the rows that are missing.
 *
 * SENDS NOTHING. No email transport, renderer, or outbox is touched.
 */
export class MarketingAudienceService {
  public constructor(
    private readonly userRepository: UserRepository,
    private readonly recipientRepository: MarketingCampaignRecipientRepository,
  ) {}

  public async materializeAllOptedIn(
    campaignId: Types.ObjectId | string,
  ): Promise<MaterializeResult> {
    let afterId: Types.ObjectId | null = null;
    let scanned = 0;
    let inserted = 0;

    for (;;) {
      const page = await this.userRepository.findMarketingOptedInProfilePage(
        afterId,
        AUDIENCE_SCAN_PAGE_SIZE,
      );
      if (page.length === 0) {
        break;
      }

      scanned += page.length;
      const userIds = page.map((p) => p.userId);
      const users = await this.userRepository.findManyByIds(userIds);

      const rows = users
        .filter(
          (user) =>
            user.role === "CUSTOMER" &&
            user.status === "ACTIVE" &&
            user.emailVerifiedAt instanceof Date &&
            typeof user.normalizedEmail === "string" &&
            user.normalizedEmail.trim().length > 0,
        )
        .map((user) => ({
          userId: user._id,
          emailFrozen: user.normalizedEmail.trim().toLowerCase(),
        }));

      inserted += await this.recipientRepository.insertPendingBatch(campaignId, rows);

      afterId = page[page.length - 1]?._id ?? null;
      if (page.length < AUDIENCE_SCAN_PAGE_SIZE) {
        break;
      }
    }

    // Authoritative count = the recipient rows that actually exist for this campaign (converges
    // correctly across resumes even when this run inserted fewer than it scanned).
    const audienceCount = await this.recipientRepository.countForCampaign(campaignId);

    logger.info(
      { operation: "marketing_audience_materialize", scanned, inserted, audienceCount },
      "Marketing campaign audience materialized",
    );

    return { audienceCount };
  }
}
