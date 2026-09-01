import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BlogPostModel } from "../../../src/modules/content/blog.model.js";
import { BlogPostRepository } from "../../../src/modules/content/blog.repository.js";
import type { EmailProviderErrorCategory } from "../../../src/modules/email/email.errors.js";
import { EmailError } from "../../../src/modules/email/email.errors.js";
import type {
  EmailTransportSendInput,
  EmailTransportSendResult,
} from "../../../src/modules/email/email.types.js";
import type { EmailTransport } from "../../../src/modules/email/email-transport.js";
import { MarketingAudienceService } from "../../../src/modules/marketing/marketing-audience.service.js";
import { MarketingCampaignModel } from "../../../src/modules/marketing/marketing-campaign.model.js";
import { MarketingCampaignRepository } from "../../../src/modules/marketing/marketing-campaign.repository.js";
import { MarketingCampaignService } from "../../../src/modules/marketing/marketing-campaign.service.js";
import { MarketingCampaignWorker } from "../../../src/modules/marketing/marketing-campaign.worker.js";
import { MarketingCampaignRecipientModel } from "../../../src/modules/marketing/marketing-campaign-recipient.model.js";
import { MarketingCampaignRecipientRepository } from "../../../src/modules/marketing/marketing-campaign-recipient.repository.js";
import { MarketingCampaignSourceService } from "../../../src/modules/marketing/marketing-campaign-source.service.js";
import { PromoCodeModel } from "../../../src/modules/promo/promo.model.js";
import { PromoRepository } from "../../../src/modules/promo/promo.repository.js";
import { UserModel, UserProfileModel } from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

class FakeTransport implements EmailTransport {
  public readonly provider = "sendgrid" as const;
  public sent: EmailTransportSendInput[] = [];
  public behavior: "ok" | EmailProviderErrorCategory = "ok";
  public isConfigured(): boolean {
    return true;
  }
  public async send(input: EmailTransportSendInput): Promise<EmailTransportSendResult> {
    this.sent.push(input);
    if (this.behavior !== "ok") {
      throw new EmailError(this.behavior);
    }
    return {
      provider: "sendgrid",
      status: "PROVIDER_ACCEPTED",
      providerMessageId: `msg-${this.sent.length}`,
    };
  }
}

const OPTS = {
  workerId: "test@local",
  batchSize: 50,
  concurrency: 3,
  maxAttempts: 4,
  retryBaseMs: 1000,
  claimTimeoutMs: 60_000,
  promoteBatchSize: 5,
};

const userRepo = new UserRepository();
const campaignRepo = new MarketingCampaignRepository();
const recipientRepo = new MarketingCampaignRecipientRepository();
const sourceService = new MarketingCampaignSourceService(
  new BlogPostRepository(),
  new PromoRepository(),
);
const audienceService = new MarketingAudienceService(userRepo, recipientRepo);
const campaignService = new MarketingCampaignService(
  campaignRepo,
  sourceService,
  audienceService,
  recipientRepo,
);
const ACTOR = "64b7f0c2e1a2b3c4d5e6f7a8";

const makeWorker = (transport: EmailTransport, now?: () => Date) =>
  new MarketingCampaignWorker(
    campaignRepo,
    recipientRepo,
    audienceService,
    sourceService,
    userRepo,
    transport,
    OPTS,
    now,
  );

const seedCustomer = async (
  over: {
    status?: "ACTIVE" | "SUSPENDED" | "DORMANT";
    verified?: boolean;
    marketingEmail?: boolean;
  } = {},
) => {
  const { status = "ACTIVE", verified = true, marketingEmail = true } = over;
  const user = await UserModel.create({
    normalizedEmail: `c-${new Types.ObjectId().toString()}@example.com`,
    passwordHash: "x",
    role: "CUSTOMER",
    status,
    ...(verified ? { emailVerifiedAt: new Date() } : {}),
    security: { passwordUpdatedAt: new Date() },
  });
  await UserProfileModel.create({
    userId: user._id,
    firstName: "Jane",
    lastName: "Doe",
    gender: "female",
    notifications: { marketingEmail },
  });
  return user;
};

const seedPublishedPost = async () =>
  BlogPostModel.create({
    title: "How to book",
    slug: `guide-${new Types.ObjectId().toString()}`,
    excerpt: "Short guide.",
    bodyHtml: "<p>b</p>",
    category: "CUSTOMER_TIPS",
    status: "PUBLISHED",
    publishedAt: new Date(),
    createdByUserId: new Types.ObjectId(),
  });

const seedPromo = async (over: Record<string, unknown> = {}) =>
  PromoCodeModel.create({
    code: "BOOKLY20",
    normalizedCode: new Types.ObjectId().toString().toUpperCase(),
    type: "PERCENTAGE",
    value: 20,
    scope: "ALL_BOOKINGS",
    businessIds: [],
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    status: "ACTIVE",
    createdByUserId: new Types.ObjectId(),
    ...over,
  });

/** create → schedule(now); leaves the campaign SCHEDULED for the worker to promote. */
const scheduleArticleCampaign = async (postId: string): Promise<string> => {
  const dto = await campaignService.create(ACTOR, { type: "ARTICLE", sourceId: postId });
  await campaignService.schedule(dto.id);
  return dto.id;
};

/** create → schedule → materialize; leaves it MATERIALIZING with `materializedAt` set and
 * recipient rows PENDING — a mid-flight state the worker will take to SENDING then drain. */
const materializeArticleCampaign = async (postId: string): Promise<string> => {
  const id = await scheduleArticleCampaign(postId);
  await campaignService.materialize(id);
  return id;
};

/** Test-only shortcut: force MATERIALIZING → SENDING, leaving recipient rows undrained. */
const forceSending = async (id: string): Promise<void> => {
  await campaignRepo.transitionStatus(id, "MATERIALIZING", "SENDING");
};

const recipients = (campaignId: string) =>
  MarketingCampaignRecipientModel.find({ campaignId }).lean().exec();
const campaign = (campaignId: string) => MarketingCampaignModel.findById(campaignId).lean().exec();

describe("marketing campaign delivery worker (database-backed)", () => {
  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  it("ARTICLE: promotes, materializes, sends, and completes — with unsubscribe headers", async () => {
    const user = await seedCustomer();
    const post = await seedPublishedPost();
    const id = await scheduleArticleCampaign(String(post._id));
    const transport = new FakeTransport();
    await makeWorker(transport).runOnce(); // SCHEDULED → MATERIALIZING → SENDING → drain → SENT

    const c = await campaign(id);
    expect(c?.status).toBe("SENT");
    expect(c?.counts).toMatchObject({ audience: 1, sent: 1 });
    expect(c?.finishedAt).toBeInstanceOf(Date);

    const [row] = await recipients(id);
    expect(row?.status).toBe("SENT");
    expect(row?.sentToEmail).toBe(user.normalizedEmail);
    expect(row?.providerMessageId).toMatch(/^msg-/);
    expect(row?.provider).toBe("sendgrid");

    expect(transport.sent).toHaveLength(1);
    const call = transport.sent[0];
    expect(call?.to).toBe(user.normalizedEmail);
    expect(call?.subject).toBe("How to book");
    expect(call?.headers?.["List-Unsubscribe"]).toMatch(
      /^<https:\/\/.+\/marketing\/unsubscribe\?token=.+>$/,
    );
    expect(call?.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(call?.html).toContain("/marketing/unsubscribe?token=");
    expect(call?.html).toContain(`/blog/${post.slug}`);
  });

  it("PROMO: sends the discount + code + qualification copy", async () => {
    await seedCustomer();
    const promo = await seedPromo();
    const dto = await campaignService.create(ACTOR, { type: "PROMO", sourceId: String(promo._id) });
    await campaignService.schedule(dto.id);
    const transport = new FakeTransport();
    await makeWorker(transport).runOnce();

    expect((await campaign(dto.id))?.status).toBe("SENT");
    const call = transport.sent[0];
    expect(call?.subject).toBe("20% off at Bookly");
    expect(call?.text).toContain(`Use code ${promo.normalizedCode} at checkout.`);
    expect(call?.html).toContain(
      "Valid on eligible bookings only, subject to terms, availability and while the offer lasts.",
    );
  });

  it("zero audience → SENT with sent=0 and NO provider calls", async () => {
    const post = await seedPublishedPost();
    const id = await scheduleArticleCampaign(String(post._id));
    const transport = new FakeTransport();
    await makeWorker(transport).runOnce();

    const c = await campaign(id);
    expect(c?.status).toBe("SENT");
    expect(c?.counts.audience).toBe(0);
    expect(c?.counts.sent).toBe(0);
    expect(c?.finishedAt).toBeInstanceOf(Date);
    expect(transport.sent).toHaveLength(0);
  });

  it("source unpublished BEFORE sending → campaign FAILED, zero provider calls", async () => {
    await seedCustomer();
    const post = await seedPublishedPost();
    const id = await scheduleArticleCampaign(String(post._id));
    await BlogPostModel.updateOne({ _id: post._id }, { $set: { status: "DRAFT" } });

    const transport = new FakeTransport();
    await makeWorker(transport).runOnce();

    const c = await campaign(id);
    expect(c?.status).toBe("FAILED");
    expect(c?.failureReason).toMatch(/source/i);
    expect(transport.sent).toHaveLength(0);
  });

  it("source unpublished MID-campaign → outstanding SKIPPED_SOURCE_INVALID, campaign FAILED", async () => {
    await seedCustomer();
    await seedCustomer();
    const post = await seedPublishedPost();
    const id = await materializeArticleCampaign(String(post._id));
    await forceSending(id);
    await BlogPostModel.updateOne({ _id: post._id }, { $set: { status: "DRAFT" } });

    const transport = new FakeTransport();
    await makeWorker(transport).runOnce();

    const c = await campaign(id);
    expect(c?.status).toBe("FAILED");
    const rows = await recipients(id);
    expect(rows.every((r) => r.status === "SKIPPED_SOURCE_INVALID")).toBe(true);
    expect(transport.sent).toHaveLength(0);
    expect(c?.counts.skippedSourceInvalid).toBe(2);
  });

  it("unsubscribe AFTER materialization → SKIPPED_OPT_OUT, no send", async () => {
    const user = await seedCustomer();
    const post = await seedPublishedPost();
    const id = await materializeArticleCampaign(String(post._id));
    await UserProfileModel.updateOne(
      { userId: user._id },
      { $set: { "notifications.marketingEmail": false } },
    );

    const transport = new FakeTransport();
    await makeWorker(transport).runOnce(); // promote → drain, live check sees opt-out

    const [row] = await recipients(id);
    expect(row?.status).toBe("SKIPPED_OPT_OUT");
    expect(transport.sent).toHaveLength(0);
    expect((await campaign(id))?.status).toBe("SENT");
  });

  it("account suspended after materialization → SKIPPED_INACTIVE", async () => {
    const user = await seedCustomer();
    const post = await seedPublishedPost();
    const id = await materializeArticleCampaign(String(post._id));
    await UserModel.updateOne({ _id: user._id }, { $set: { status: "SUSPENDED" } });

    const transport = new FakeTransport();
    await makeWorker(transport).runOnce();

    expect((await recipients(id))[0]?.status).toBe("SKIPPED_INACTIVE");
    expect(transport.sent).toHaveLength(0);
  });

  it("email unverified after materialization → SKIPPED_UNVERIFIED", async () => {
    const user = await seedCustomer();
    const post = await seedPublishedPost();
    const id = await materializeArticleCampaign(String(post._id));
    await UserModel.updateOne({ _id: user._id }, { $unset: { emailVerifiedAt: "" } });

    const transport = new FakeTransport();
    await makeWorker(transport).runOnce();

    expect((await recipients(id))[0]?.status).toBe("SKIPPED_UNVERIFIED");
    expect(transport.sent).toHaveLength(0);
  });

  it("email changed after materialization → sends to the live address, emailFrozen unchanged", async () => {
    const user = await seedCustomer();
    const frozen = user.normalizedEmail;
    const post = await seedPublishedPost();
    const id = await materializeArticleCampaign(String(post._id));
    const newEmail = `new-${new Types.ObjectId().toString()}@example.com`;
    await UserModel.updateOne({ _id: user._id }, { $set: { normalizedEmail: newEmail } });

    const transport = new FakeTransport();
    await makeWorker(transport).runOnce();

    const [row] = await recipients(id);
    expect(row?.emailFrozen).toBe(frozen);
    expect(row?.sentToEmail).toBe(newEmail);
    expect(transport.sent[0]?.to).toBe(newEmail);
  });

  it("retryable provider error → scheduleRetry with a future nextAttemptAt; permanent → FAILED", async () => {
    await seedCustomer();
    const post = await seedPublishedPost();
    const id = await scheduleArticleCampaign(String(post._id));

    const transient = new FakeTransport();
    transient.behavior = "PROVIDER_TRANSIENT";
    await makeWorker(transient).runOnce(); // SENDING + attempt 1 → retry
    let [row] = await recipients(id);
    expect(row?.status).toBe("PENDING");
    expect(row?.nextAttemptAt).toBeInstanceOf(Date);
    expect(row?.lastErrorCategory).toBe("PROVIDER_TRANSIENT");
    expect(row?.attemptCount).toBe(1);

    const permanent = new FakeTransport();
    permanent.behavior = "PROVIDER_PERMISSION_OR_SENDER_ERROR";
    const future = () => new Date(Date.now() + 10 * 60_000); // past nextAttemptAt
    await makeWorker(permanent, future).runOnce();
    [row] = await recipients(id);
    expect(row?.status).toBe("FAILED");
    expect(row?.lastErrorCategory).toBe("PROVIDER_PERMISSION_OR_SENDER_ERROR");
  });

  it("transport NOT_CONFIGURED → recipient FAILED, campaign FAILED, remaining not burned one-by-one", async () => {
    await seedCustomer();
    await seedCustomer();
    await seedCustomer();
    const post = await seedPublishedPost();
    const id = await scheduleArticleCampaign(String(post._id));
    const transport = new FakeTransport();
    transport.behavior = "NOT_CONFIGURED";
    await makeWorker(transport).runOnce();

    const c = await campaign(id);
    expect(c?.status).toBe("FAILED");
    expect(c?.failureReason).toMatch(/transport/i);
    expect(transport.sent.length).toBeLessThanOrEqual(3);
    const rows = await recipients(id);
    expect(rows.every((r) => r.status === "FAILED")).toBe(true);
    expect(c?.counts.failed).toBe(3);
  });

  it("cancel during SENDING → outstanding CANCELLED, sent stay SENT, worker stops", async () => {
    await seedCustomer();
    await seedCustomer();
    const post = await seedPublishedPost();
    const id = await materializeArticleCampaign(String(post._id));
    await forceSending(id);

    await campaignService.cancel(id); // SENDING is cancellable; terminalizes outstanding rows

    const transport = new FakeTransport();
    await makeWorker(transport).runOnce(); // sees status !== SENDING → no claims

    const c = await campaign(id);
    expect(c?.status).toBe("CANCELLED");
    const rows = await recipients(id);
    expect(rows.every((r) => r.status === "CANCELLED")).toBe(true);
    expect(c?.counts.cancelled).toBe(2);
    expect(transport.sent).toHaveLength(0);
  });

  it("counts always reconcile to the audience total from terminal recipient states", async () => {
    await seedCustomer(); // will send
    await seedCustomer({ marketingEmail: false }); // excluded at materialization
    const optOutLater = await seedCustomer();
    const post = await seedPublishedPost();
    const id = await materializeArticleCampaign(String(post._id));
    await UserProfileModel.updateOne(
      { userId: optOutLater._id },
      { $set: { "notifications.marketingEmail": false } },
    );

    const transport = new FakeTransport();
    await makeWorker(transport).runOnce();

    const c = await campaign(id);
    expect(c?.status).toBe("SENT");
    const counts = c?.counts;
    if (!counts) throw new Error("campaign has no counts");
    const terminalSum =
      counts.sent +
      counts.skippedOptOut +
      counts.skippedUnverified +
      counts.skippedInactive +
      counts.skippedSourceInvalid +
      counts.failed +
      counts.cancelled;
    expect(terminalSum).toBe(counts.audience);
    expect(counts.audience).toBe(2);
    expect(counts.sent).toBe(1);
    expect(counts.skippedOptOut).toBe(1);
  });

  it("stale PROCESSING rows are reclaimed and eventually sent", async () => {
    await seedCustomer();
    const post = await seedPublishedPost();
    const id = await materializeArticleCampaign(String(post._id));
    await forceSending(id);

    await MarketingCampaignRecipientModel.updateOne(
      { campaignId: id },
      {
        $set: {
          status: "PROCESSING",
          claimedAt: new Date(Date.now() - 10 * 60_000),
          claimedBy: "dead@worker:x",
          attemptCount: 1,
        },
      },
    );

    const transport = new FakeTransport();
    await makeWorker(transport).runOnce();

    const [row] = await recipients(id);
    expect(row?.status).toBe("SENT");
    expect(row?.attemptCount).toBeGreaterThanOrEqual(2);
  });
});
