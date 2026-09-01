import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MarketingAudienceService } from "../../../src/modules/marketing/marketing-audience.service.js";
import { MarketingCampaignModel } from "../../../src/modules/marketing/marketing-campaign.model.js";
import { MarketingCampaignRecipientModel } from "../../../src/modules/marketing/marketing-campaign-recipient.model.js";
import { MarketingCampaignRecipientRepository } from "../../../src/modules/marketing/marketing-campaign-recipient.repository.js";
import { UserModel, UserProfileModel } from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const recipientRepo = new MarketingCampaignRecipientRepository();
const audienceService = new MarketingAudienceService(new UserRepository(), recipientRepo);

type SeedOpts = {
  role?: "CUSTOMER" | "BUSINESS_OWNER";
  status?: "ACTIVE" | "SUSPENDED" | "DORMANT";
  verified?: boolean;
  marketingEmail?: boolean | undefined; // undefined => field absent
};

const seedUser = async (opts: SeedOpts = {}) => {
  const { role = "CUSTOMER", status = "ACTIVE", verified = true } = opts;
  // NB: cannot use a destructuring default here — `{ marketingEmail: undefined }` must mean
  // "no field", not "fall back to true".
  const marketingEmail = "marketingEmail" in opts ? opts.marketingEmail : true;
  const user = await UserModel.create({
    normalizedEmail: `u-${new Types.ObjectId().toString()}@example.com`,
    passwordHash: "x",
    role,
    status,
    ...(verified ? { emailVerifiedAt: new Date() } : {}),
    security: { passwordUpdatedAt: new Date() },
  });
  await UserProfileModel.create({
    userId: user._id,
    firstName: "Jane",
    lastName: "Doe",
    gender: "female",
    ...(marketingEmail === undefined ? {} : { notifications: { marketingEmail } }),
  });
  return user;
};

const newCampaign = async () =>
  MarketingCampaignModel.create({
    type: "ARTICLE",
    ownerScope: "PLATFORM",
    createdByUserId: new Types.ObjectId(),
    source: {
      kind: "BLOG_POST",
      sourceId: String(new Types.ObjectId()),
      sourceSlug: "x",
      ctaUrl: "http://localhost:3000/blog/x",
      snapshot: { title: "t", excerpt: "e", coverImageUrl: null },
    },
    audience: { scope: "ALL_OPTED_IN" },
    status: "MATERIALIZING",
    scheduledAt: new Date(),
    counts: {},
  });

describe("marketing audience materialization (database-backed)", () => {
  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  it("includes only opted-in, ACTIVE, verified CUSTOMER accounts and freezes the verified email", async () => {
    const included = await seedUser();
    await seedUser({ marketingEmail: false });
    await seedUser({ marketingEmail: undefined });
    await seedUser({ status: "SUSPENDED" });
    await seedUser({ status: "DORMANT" });
    await seedUser({ verified: false });
    await seedUser({ role: "BUSINESS_OWNER" });

    const campaign = await newCampaign();
    const { audienceCount } = await audienceService.materializeAllOptedIn(campaign._id);

    expect(audienceCount).toBe(1);
    const rows = await MarketingCampaignRecipientModel.find({ campaignId: campaign._id })
      .lean()
      .exec();
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.userId)).toBe(String(included._id));
    expect(rows[0]?.status).toBe("PENDING");
    expect(rows[0]?.emailFrozen).toBe(included.normalizedEmail);
    expect(rows[0]?.attemptCount).toBe(0);
  });

  it("never creates a row for a manual/unlinked contact (no UserProfile opt-in exists)", async () => {
    // A booking-snapshot / BusinessClient contact has no UserProfile with marketingEmail:true, so
    // the opted-in scan simply never sees it. Prove the scan is profile-driven.
    await UserModel.create({
      normalizedEmail: `manual-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "x",
      role: "CUSTOMER",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
      security: { passwordUpdatedAt: new Date() },
    });
    const campaign = await newCampaign();
    const { audienceCount } = await audienceService.materializeAllOptedIn(campaign._id);
    expect(audienceCount).toBe(0);
  });

  it("is idempotent — a re-run adds no duplicate rows and the count converges", async () => {
    await seedUser();
    await seedUser();
    const campaign = await newCampaign();

    const first = await audienceService.materializeAllOptedIn(campaign._id);
    const second = await audienceService.materializeAllOptedIn(campaign._id);

    expect(first.audienceCount).toBe(2);
    expect(second.audienceCount).toBe(2);
    expect(await recipientRepo.countForCampaign(campaign._id)).toBe(2);
  });

  it("dedupe: a partly-overlapping batch inserts only the new rows; a fully-overlapping batch is a no-op", async () => {
    const [u1, u2, u3] = await Promise.all([seedUser(), seedUser(), seedUser()]);
    const campaign = await newCampaign();
    const row = (u: Awaited<ReturnType<typeof seedUser>>) => ({
      userId: u._id,
      emailFrozen: u.normalizedEmail,
    });

    expect(await recipientRepo.insertPendingBatch(campaign._id, [row(u1), row(u2)])).toBe(2);
    // u1/u2 already present, u3 new → only 1 inserted, no throw
    expect(await recipientRepo.insertPendingBatch(campaign._id, [row(u1), row(u2), row(u3)])).toBe(
      1,
    );
    // all present → 0 inserted, still no throw
    expect(await recipientRepo.insertPendingBatch(campaign._id, [row(u1), row(u3)])).toBe(0);

    expect(await recipientRepo.countForCampaign(campaign._id)).toBe(3);
  });

  it("has the partial marketingEmail index on UserProfile", async () => {
    const idx = (await UserProfileModel.collection.indexes()) as Array<{
      key: Record<string, number>;
      partialFilterExpression?: Record<string, unknown>;
    }>;
    const hit = idx.find((i) => i.key["notifications.marketingEmail"] === 1);
    expect(hit?.partialFilterExpression).toEqual({ "notifications.marketingEmail": true });
  });
});
