import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { createMarketingRoute } from "../../../src/modules/marketing/marketing.route.js";
import { signMarketingUnsubscribeToken } from "../../../src/modules/marketing/marketing-unsubscribe.token.js";
import { UserModel, UserProfileModel } from "../../../src/modules/user/user.model.js";
import type { NotificationPreferences } from "../../../src/modules/user/user.types.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/**
 * Marketing Email Stage M2 — public unsubscribe endpoint, end to end against a real replica set.
 */

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/marketing", createMarketingRoute());
app.use(createErrorHandler({ isProduction: true }));

const seedCustomer = async (
  notifications?: NotificationPreferences,
): Promise<{ userId: string; profileId: string }> => {
  const user = await UserModel.create({
    normalizedEmail: `m2-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    passwordHash: "x",
    role: "CUSTOMER",
    security: { passwordUpdatedAt: new Date() },
  });
  const profile = await UserProfileModel.create({
    userId: user._id,
    firstName: "Jane",
    lastName: "Doe",
    gender: "female",
    ...(notifications ? { notifications } : {}),
  });
  return { userId: String(user._id), profileId: String(profile._id) };
};

const readNotifications = async (profileId: string) =>
  (await UserProfileModel.findById(profileId).lean().exec())?.notifications;

describe("marketing unsubscribe endpoint (database-backed)", () => {
  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  it("sets marketingEmail=false for a valid token, with no auth, and preserves reminder siblings", async () => {
    const { userId, profileId } = await seedCustomer({
      appointmentReminderEmail: true,
      appointmentReminderSms: true,
      marketingEmail: true,
    });
    const token = await signMarketingUnsubscribeToken(userId);

    const response = await request(app).post("/marketing/unsubscribe").send({ token }).expect(200);
    expect(response.body).toMatchObject({ success: true });

    expect(await readNotifications(profileId)).toMatchObject({
      appointmentReminderEmail: true,
      appointmentReminderSms: true,
      marketingEmail: false,
    });
  });

  it("is idempotent — repeating the same token, and an already-unsubscribed account, both succeed", async () => {
    const { userId, profileId } = await seedCustomer({ marketingEmail: true });
    const token = await signMarketingUnsubscribeToken(userId);

    await request(app).post("/marketing/unsubscribe").send({ token }).expect(200);
    await request(app).post("/marketing/unsubscribe").send({ token }).expect(200);
    await request(app).post("/marketing/unsubscribe").send({ token }).expect(200);

    expect((await readNotifications(profileId))?.marketingEmail).toBe(false);
  });

  it("succeeds without revealing that the account/profile does not exist (no enumeration)", async () => {
    const token = await signMarketingUnsubscribeToken("64b7f0c2e1a2b3c4d5e6f7a8");
    const response = await request(app).post("/marketing/unsubscribe").send({ token }).expect(200);
    expect(response.body).toMatchObject({ success: true });
  });

  it("accepts the RFC 8058 one-click shape: token in the query, form body ignored", async () => {
    const { userId, profileId } = await seedCustomer({ marketingEmail: true });
    const token = await signMarketingUnsubscribeToken(userId);

    await request(app)
      .post(`/marketing/unsubscribe?token=${encodeURIComponent(token)}`)
      .type("form")
      .send("List-Unsubscribe=One-Click")
      .expect(200);

    expect((await readNotifications(profileId))?.marketingEmail).toBe(false);
  });

  it("can never set marketingEmail=true — a truthy value in the body is ignored", async () => {
    const { userId, profileId } = await seedCustomer({ marketingEmail: false });
    const token = await signMarketingUnsubscribeToken(userId);

    await request(app)
      .post("/marketing/unsubscribe")
      .send({ token, marketingEmail: true, notifications: { marketingEmail: true } })
      .expect(200);

    expect((await readNotifications(profileId))?.marketingEmail).toBe(false);
  });

  it("rejects a missing / invalid / tampered token with one generic 400 that leaks nothing", async () => {
    const { userId } = await seedCustomer({ marketingEmail: true });
    const valid = await signMarketingUnsubscribeToken(userId);

    for (const body of [{}, { token: "" }, { token: "not-a-jwt" }, { token: `${valid}tamper` }]) {
      const response = await request(app).post("/marketing/unsubscribe").send(body).expect(400);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe(
        "This unsubscribe link is invalid or no longer available.",
      );
      expect(JSON.stringify(response.body)).not.toContain(userId);
      expect(JSON.stringify(response.body)).not.toMatch(/@example\.com/);
    }
  });

  it("records marketingEmailConsent {source:'unsubscribe'} alongside the opt-out (Stage M3A)", async () => {
    const { userId, profileId } = await seedCustomer({ marketingEmail: true });
    const token = await signMarketingUnsubscribeToken(userId);

    await request(app).post("/marketing/unsubscribe").send({ token }).expect(200);

    const profile = await UserProfileModel.findById(profileId).lean().exec();
    expect(profile?.notifications?.marketingEmail).toBe(false);
    expect(profile?.marketingEmailConsent?.source).toBe("unsubscribe");
    expect(profile?.marketingEmailConsent?.updatedAt).toBeInstanceOf(Date);
  });

  it("does not touch any other profile field", async () => {
    const { userId, profileId } = await seedCustomer({ marketingEmail: true });
    const before = await UserProfileModel.findById(profileId).lean().exec();
    const token = await signMarketingUnsubscribeToken(userId);

    await request(app).post("/marketing/unsubscribe").send({ token }).expect(200);

    const after = await UserProfileModel.findById(profileId).lean().exec();
    expect(after?.firstName).toBe(before?.firstName);
    expect(after?.lastName).toBe(before?.lastName);
    expect(after?.gender).toBe(before?.gender);
    expect(String(after?.userId)).toBe(String(before?.userId));
  });
});
