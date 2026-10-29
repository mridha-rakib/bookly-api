/** P4K isolated interactive First-Class Package harness.
 *
 * Composes the SHIPPED ExpressApplication (all routes, auth, CORS, rate limit, error handler)
 * over a freshly launched disposable Mongo replica, with only the substitutions declared in
 * p4k-synthetic-authority.setup.ts. A separate loopback control console drives the fake
 * gateway and the synthetic consent clock. Nothing here is part of src/ or any build.
 *
 * Results are "valid under isolated synthetic test authority" ONLY. They never authorize a
 * real charge, entitlement, Calendar release or settlement, and must never be copied out.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import mongoose from "mongoose";
import { ExpressApplication } from "../../src/app/app.js";
import { PaymentAttemptModel } from "../../src/modules/payment/payment-attempt.model.js";
import {
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "../integration/database/mongo-replset-helper.js";
import {
  type ConsentClockMode,
  capturedEmails,
  harnessGateway,
  P4K_LABEL,
  P4K_SETUP_MARKER,
  PROVIDER_ENV,
  readConsentClock,
  setConsentClock,
  simulateAuthentication,
} from "./p4k-harness-state.js";
import { type P4kSeed, seedP4k } from "./p4k-seed.js";

const loopback = "127.0.0.1";
const port = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1024 || value > 65535)
    throw Error(`${name} must be a port in 1024..65535`);
  return value;
};

export type P4kHarness = {
  apiOrigin: string;
  controlOrigin: string;
  uiOrigin: string;
  database: string;
  seed: P4kSeed;
  /** Per-session console secret (random, never logged by the app, never sent to the UI origin). */
  controlToken: string;
  consoleUrl: string;
  stop: () => Promise<void>;
};

const listen = (app: express.Express, portNumber: number) =>
  new Promise<Server>((resolve, reject) => {
    const server = app.listen({ port: portNumber, host: loopback }, () => resolve(server));
    server.once("error", reject);
  });
const close = (server?: Server) =>
  new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));

/** Proves the synthetic setup is loaded and the target is a brand-new loopback replica. */
async function assertIsolation(database: string) {
  if ((globalThis as Record<symbol, unknown>)[P4K_SETUP_MARKER] !== true)
    throw Error(
      "P4K harness requires vitest.p4k-interactive.config.ts (synthetic setup not loaded)",
    );
  if (process.env["MONGODB_URI"])
    throw Error("P4K harness refuses an inherited MONGODB_URI; it owns its own replica");
  if (process.env["NODE_ENV"] === "production")
    throw Error("P4K harness never runs with NODE_ENV=production");
  const providerKeys = Object.keys(process.env).filter((key) => PROVIDER_ENV.test(key));
  if (providerKeys.length)
    throw Error(
      `P4K harness refuses provider configuration in its process: ${providerKeys.join(", ")}`,
    );
  const connection = mongoose.connection;
  if (
    connection.host !== loopback ||
    connection.name !== database ||
    !database.startsWith("bookly_auth_")
  )
    throw Error("P4K harness database is not the freshly launched loopback replica");
  const hello = await connection.db?.admin().command({ hello: 1 });
  if (!hello?.["setName"])
    throw Error("P4K harness requires a replica set (majority/transaction semantics)");
  const users = await connection.db?.collection("users").countDocuments();
  if (users) throw Error("P4K harness database already contains users; refusing to seed");
}

/** The console is reachable only by a holder of the per-session token printed to the runner's
 * terminal: no CORS for any origin (including the app's UI origin), exact loopback Host
 * (DNS-rebinding guard), and a bearer secret on every route except the static page shell. */
export function controlApp(input: {
  uiOrigin: string;
  seed: P4kSeed;
  apiOrigin: string;
  controlOrigin: string;
  token: string;
}) {
  const { uiOrigin, seed, apiOrigin, controlOrigin, token } = input;
  const expected = Buffer.from(`Bearer ${token}`);
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.headers.host !== new URL(controlOrigin).host)
      return void res.status(421).json({ error: "host rejected" });
    // Same-origin console page only; the app under test and any other page are refused.
    const origin = req.headers.origin;
    if (origin && origin !== controlOrigin)
      return void res.status(403).json({ error: "origin rejected" });
    if (req.method === "GET" && req.path === "/") {
      next();
      return;
    }
    const presented = Buffer.from(String(req.headers.authorization ?? ""));
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected))
      return void res.status(401).json({ error: "P4K console token required" });
    next();
  });
  app.use(express.json({ limit: "16kb" }));
  const intents = async () =>
    Promise.all(
      harnessGateway.createdPaymentIntentIds().map(async (id) => {
        const snapshot = await harnessGateway.retrievePaymentIntent(id);
        const attempt = await PaymentAttemptModel.findOne({ providerPaymentIntentId: id }).lean();
        return {
          paymentIntentId: id,
          status: snapshot.status,
          amountCents: snapshot.amountCents,
          productKind: attempt?.productKind ?? null,
          logicalIdempotencyKey: attempt?.logicalIdempotencyKey ?? null,
        };
      }),
    );
  app.get("/state", async (_req, res) => {
    res.json({
      label: P4K_LABEL,
      apiOrigin,
      uiOrigin,
      consentClock: readConsentClock(),
      password: seed.password,
      accounts: seed.accounts,
      venue: seed.venue,
      travel: seed.travel,
      paymentIntents: await intents(),
      emails: capturedEmails.length,
    });
  });
  app.get("/emails", (_req, res) => {
    res.json(capturedEmails.map(({ attachments: _a, ...mail }) => mail));
  });
  app.post("/payments/next-charge", (req, res) => {
    const outcome = String(req.body?.outcome);
    if (outcome === "lost")
      harnessGateway.queueNextChargeLostResponse(Error("P4K simulated lost provider response"));
    else if (outcome === "throw-before-create")
      harnessGateway.queueNextChargeThrowBeforeCreate(Error("P4K simulated pre-create failure"));
    else if (["succeeded", "requires_action", "failed"].includes(outcome))
      harnessGateway.queueNextChargeOutcome(outcome as "succeeded" | "requires_action" | "failed");
    else
      return void res
        .status(400)
        .json({ error: "outcome: succeeded|requires_action|failed|lost|throw-before-create" });
    return void res.json({ queued: outcome });
  });
  app.post("/payments/next-refund", (req, res) => {
    const outcome = String(req.body?.outcome);
    if (!["succeeded", "pending", "failed"].includes(outcome))
      return void res.status(400).json({ error: "outcome: succeeded|pending|failed" });
    harnessGateway.queueNextRefundOutcome(outcome as "succeeded" | "pending" | "failed");
    return void res.json({ queued: outcome });
  });
  /** Simulated 3DS/authentication result for one existing fake PaymentIntent (see
   * simulateAuthentication). The app must still re-read it and prove persistence itself. */
  app.post("/payments/authenticate", (req, res) => {
    try {
      return void res.json(
        simulateAuthentication(
          {
            clientSecret: req.body?.clientSecret ? String(req.body.clientSecret) : undefined,
            paymentIntentId: req.body?.paymentIntentId
              ? String(req.body.paymentIntentId)
              : undefined,
          },
          String(req.body?.result ?? ""),
        ),
      );
    } catch (error) {
      return void res.status(400).json({ error: String((error as Error).message) });
    }
  });
  app.post("/consent-clock", (req, res) => {
    const mode = String(req.body?.mode);
    let next: ConsentClockMode;
    if (mode === "NORMAL" || mode === "UNAVAILABLE") next = { mode };
    else if (mode === "SKEW") next = { mode, skewMs: Number(req.body?.skewMs) };
    else return void res.status(400).json({ error: "mode: NORMAL|SKEW|UNAVAILABLE" });
    try {
      setConsentClock(next);
    } catch (error) {
      return void res.status(400).json({ error: String(error) });
    }
    return void res.json(readConsentClock());
  });
  app.get("/", (_req, res) => {
    res.type("html").send(`<!doctype html><meta charset="utf-8"><title>P4K synthetic console</title>
<style>body{font:14px system-ui;margin:16px;max-width:900px}button{margin:2px}pre{background:#f4f4f4;padding:8px;overflow:auto}</style>
<h1>P4K isolated synthetic console</h1><p>Open this page only through the URL printed by the harness (it carries the session token in the fragment).</p><p><b>${P4K_LABEL}.</b> Disposable database; fake payments; synthetic consent clock.</p>
<h2>Next charge</h2>${["succeeded", "requires_action", "failed", "lost", "throw-before-create"].map((o) => `<button onclick="post('/payments/next-charge',{outcome:'${o}'})">${o}</button>`).join("")}
<h2>Authenticate pending PaymentIntent (simulated 3DS)</h2><input id="pi" size="50" placeholder="pi_fake_..."> ${["succeeded", "failed", "canceled"].map((r) => `<button onclick="post('/payments/authenticate',{paymentIntentId:pi.value,result:'${r}'})">${r}</button>`).join("")}
<h2>Synthetic consent clock</h2><button onclick="post('/consent-clock',{mode:'NORMAL'})">NORMAL</button>
<button onclick="post('/consent-clock',{mode:'SKEW',skewMs:1800001})">SKEW +30 min +1 ms (late)</button>
<button onclick="post('/consent-clock',{mode:'UNAVAILABLE'})">UNAVAILABLE</button>
<h2>State</h2><button onclick="load()">Refresh</button><pre id="out"></pre>
<script>
const auth={authorization:'Bearer '+(new URLSearchParams(location.hash.slice(1)).get('token')||'')};
async function post(path, body){const r=await fetch(path,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify(body)});out.textContent=JSON.stringify(await r.json(),null,2);}
async function load(){out.textContent=JSON.stringify(await (await fetch('/state',{headers:auth})).json(),null,2);} load();
</script>`);
  });
  return app;
}

export async function startP4kHarness(): Promise<P4kHarness> {
  const apiPort = port("BOOKLY_P4K_API_PORT", 3100),
    controlPort = port("BOOKLY_P4K_CONTROL_PORT", 3199);
  const uiOrigin = process.env["CORS_ORIGINS"] ?? "";
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(uiOrigin))
    throw Error("P4K UI origin missing; synthetic setup not loaded");
  const database = await connectIsolatedDatabase();
  let api: Server | undefined, control: Server | undefined;
  try {
    await assertIsolation(database);
    const seed = await seedP4k();
    const reader = {
      getConnectionState: () =>
        mongoose.connection.readyState === 1 ? ("connected" as const) : ("disconnected" as const),
    };
    api = await listen(new ExpressApplication(reader).app, apiPort);
    const apiOrigin = `http://${loopback}:${apiPort}`;
    const controlOrigin = `http://${loopback}:${controlPort}`,
      controlToken = randomBytes(32).toString("base64url");
    control = await listen(
      controlApp({ uiOrigin, seed, apiOrigin, controlOrigin, token: controlToken }),
      controlPort,
    );
    return {
      apiOrigin,
      controlOrigin,
      uiOrigin,
      database,
      seed,
      controlToken,
      consoleUrl: `${controlOrigin}/#token=${controlToken}`,
      stop: async () => {
        await close(control);
        await close(api);
        await stopIsolatedReplicaSet();
      },
    };
  } catch (error) {
    await close(control);
    await close(api);
    await stopIsolatedReplicaSet();
    throw error;
  }
}
