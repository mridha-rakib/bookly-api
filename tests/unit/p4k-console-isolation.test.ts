import request from "supertest";
import { describe, expect, it } from "vitest";
import { controlApp } from "../interactive/p4k-harness.js";
import { simulateAuthentication } from "../interactive/p4k-harness-state.js";
import type { P4kSeed } from "../interactive/p4k-seed.js";

// P4K-2: the synthetic control console is reachable only with the per-session token, from its
// own loopback origin and Host. No database or network is used (no PaymentIntents exist).
const controlOrigin = "http://127.0.0.1:3199",
  uiOrigin = "http://127.0.0.1:3101",
  token = "t".repeat(43);
const seed = { password: "synthetic", accounts: {}, venue: {}, travel: {} } as unknown as P4kSeed;
const app = controlApp({
  uiOrigin,
  seed,
  apiOrigin: "http://127.0.0.1:3100",
  controlOrigin,
  token,
});
const host = "127.0.0.1:3199",
  auth = `Bearer ${token}`;

describe("P4K-2 control console boundary", () => {
  it("serves only the static shell without the token, and never embeds the token", async () => {
    const shell = await request(app).get("/").set("Host", host);
    expect(shell.status).toBe(200);
    expect(shell.text).not.toContain(token);
    for (const path of ["/state", "/emails"])
      expect((await request(app).get(path).set("Host", host)).status).toBe(401);
    expect(
      (
        await request(app)
          .post("/consent-clock")
          .set("Host", host)
          .set("x-p4k-control", "1")
          .send({ mode: "UNAVAILABLE" })
      ).status,
    ).toBe(401);
  });
  it("rejects a wrong token, the app's UI origin and a foreign Host even with the token", async () => {
    expect(
      (
        await request(app)
          .get("/state")
          .set("Host", host)
          .set("Authorization", `Bearer ${"x".repeat(43)}`)
      ).status,
    ).toBe(401);
    const fromUi = await request(app)
      .get("/state")
      .set("Host", host)
      .set("Origin", uiOrigin)
      .set("Authorization", auth);
    expect(fromUi.status).toBe(403);
    expect(fromUi.headers["access-control-allow-origin"]).toBeUndefined();
    expect(
      (
        await request(app)
          .get("/state")
          .set("Host", "p4k.attacker.invalid:3199")
          .set("Authorization", auth)
      ).status,
    ).toBe(421);
  });
  it("accepts the token holder and still refuses unknown PaymentIntents", async () => {
    const state = await request(app).get("/state").set("Host", host).set("Authorization", auth);
    expect(state.status).toBe(200);
    expect(state.body.paymentIntents).toEqual([]);
    const forged = await request(app)
      .post("/payments/authenticate")
      .set("Host", host)
      .set("Authorization", auth)
      .send({
        paymentIntentId: "pi_fake_00000000-0000-0000-0000-000000000000",
        result: "succeeded",
      });
    expect(forged.status).toBe(400);
    expect(() =>
      simulateAuthentication({ clientSecret: "pi_live_real_secret" }, "succeeded"),
    ).toThrow();
  });
});
