/** P4K authored browser journeys (NOT EXECUTED in P4K). Real Next dev server + approved Chrome
 * against the isolated harness. Assertions read server truth from the disposable database or
 * shipped HTTP routes, never from a fake payment acknowledgement.
 *
 * Selected only with BOOKLY_P4K_BROWSER_ARTIFACTS=<new empty directory> plus
 * BOOKLY_P4K_CLIENT_ROOT and BOOKLY_TEST_BROWSER. See dev/local/README.md (P4K section).
 */

import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Types } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BookingModel } from "../../src/modules/booking/booking.model.js";
import { BookingCreationClaimModel } from "../../src/modules/booking/booking-creation-claim.model.js";
import { PackageConsentEvidenceModel } from "../../src/modules/booking/package-consent-evidence.js";
import {
  lifecycleOperationId,
  PackageLifecycleOperationModel,
} from "../../src/modules/booking/package-lifecycle-operation.js";
import { BookingFinancialTransactionModel } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
import { BookingSlotReservationModel } from "../../src/modules/booking-slot-reservation/booking-slot-reservation.model.js";
import { BusinessClientModel } from "../../src/modules/client/client.model.js";
import { ClientRepository } from "../../src/modules/client/client.repository.js";
import { PackageProgressV2Model } from "../../src/modules/package-progress/package-progress-v2.model.js";
import { PaymentAttemptModel } from "../../src/modules/payment/payment-attempt.model.js";
import { openP4kBrowser, type P4kPage } from "./p4k-browser.js";
import { type P4kClient, startP4kClient } from "./p4k-client.js";
import { type P4kHarness, startP4kHarness } from "./p4k-harness.js";
import { harnessGateway, setConsentClock, simulateAuthentication } from "./p4k-harness-state.js";

const artifacts = process.env["BOOKLY_P4K_BROWSER_ARTIFACTS"];
const clientRoot = process.env["BOOKLY_P4K_CLIENT_ROOT"];
const enabled = Boolean(artifacts && clientRoot);

let h: P4kHarness, page: P4kPage, next: P4kClient | undefined;
const results: Array<{ journey: string; result: "PASS" | "FAIL"; detail?: string }> = [];

/** Business-local YYYY-MM-DD, n days ahead. */
const day = (n: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Nicosia" }).format(
    new Date(Date.now() + n * 86400000),
  );
async function api(path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const response = await fetch(`${h.apiOrigin}/api/v1${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const json = (await response.json().catch(() => ({}))) as { data?: Record<string, unknown> };
  return { status: response.status, data: (json.data ?? {}) as Record<string, any> };
}
async function token(email: string, kind: "customer" | "professional") {
  const r = await api(`/auth/${kind}/login`, {
    method: "POST",
    body: { email, password: h.seed.password },
  });
  if (r.status !== 200 || typeof r.data["accessToken"] !== "string")
    throw Error(`Synthetic ${kind} login failed (${r.status})`);
  return r.data["accessToken"] as string;
}
const consentUrl = (businessId: Types.ObjectId, packageId: Types.ObjectId) =>
  `${h.uiOrigin}/customer/package-consent/${businessId}/${packageId}`;

async function loginCustomerUi(email: string, target: string) {
  await page.clearStorage();
  await page.goto(target);
  await page.waitFor("location.pathname === '/select-role'", 180000);
  await page.click("Continue");
  await page.waitFor(
    "location.pathname === '/customer' && document.querySelector('input[type=email]')",
    180000,
  );
  await page.fill("input[type=email]", email);
  await page.evaluate("document.querySelector('form').requestSubmit()");
  await page.waitFor(
    "location.pathname === '/customer/password' && document.querySelector('input[type=password]')",
    180000,
  );
  await page.fill("input[type=password]", h.seed.password);
  await page.evaluate("document.querySelector('form').requestSubmit()");
  await page.waitFor(`location.pathname === ${JSON.stringify(new URL(target).pathname)}`, 180000);
}

type Row = { service: string; dayOffset: number; addon?: boolean };
/** Selection → canonical server quote → exact terms. Returns the retained operation id. */
async function selectAndPresent(rows: Row[], travel?: boolean) {
  await page.waitFor(
    "Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('appointment ('))",
    180000,
  );
  for (const row of rows) {
    await page.click(`Add ${row.service} appointment`);
    await page.waitFor(
      "document.querySelector('select[aria-label=\"Package appointment professional\"]')",
    );
    await page.select("Package appointment professional", "first");
    if (travel)
      await page.travel({
        city: "Larnaca",
        area: "Center",
        streetName: "Synthetic",
        streetNumber: "7",
      });
    await page.fill("input[aria-label='Package appointment date']", day(row.dayOffset));
    await page.click("Find available times");
    await page.waitFor(
      "Array.from(document.querySelectorAll('select[aria-label=\"Package appointment time\"]')).pop().options.length > 1",
      60000,
    );
    await page.select("Package appointment time", "first");
    if (row.addon) await page.check("Synthetic scalp treatment");
  }
  await page.click("Review selected terms");
  await page.waitFor("document.querySelector('[aria-label=\"Exact Package terms\"]')", 120000);
  const operationId = new URL(await page.evaluate<string>("location.href")).searchParams.get(
    "operation",
  );
  if (!operationId) throw Error("Operation selector was not retained in the URL");
  // No implicit agreement: unchecked and disabled until the Customer acts.
  expect(await page.evaluate("!document.querySelector('input[type=checkbox]').checked")).toBe(true);
  return operationId;
}
/** Affirmative acceptance through the existing protocol (synthetic trusted time). */
async function acceptTerms() {
  await page.check("I have reviewed and agree");
  await page.click("Accept these terms");
  await page.waitFor("document.body.innerText.includes('Terms accepted')", 120000);
}
async function selectAndAccept(rows: Row[], travel?: boolean) {
  const operationId = await selectAndPresent(rows, travel);
  await acceptTerms();
  return operationId;
}
const purchaseText = () =>
  page.waitFor(
    "document.body.innerText.includes('Package purchase verified by the server') || document.body.innerText.includes('Purchase unconfirmed')",
    120000,
  );
/** Owner records the original venue settlement when the purchase left a venue balance. */
async function settleIfNeeded(progressId: string) {
  const owned = await api(`/package-views/owned/${progressId}`, {
    token: await token(h.seed.accounts.customer, "customer"),
  });
  const pkg = (owned.data["packages"] as Array<Record<string, any>>)[0]!;
  if (pkg["purchaseFinancials"]?.balanceSettled) return;
  const owner = await token(h.seed.accounts.owner, "professional");
  const settle = await api("/package-views/actions/settlement", {
    method: "POST",
    token: owner,
    body: {
      businessId: String(pkg["businessId"]),
      packageProgressId: progressId,
      key: randomUUID(),
      bookingId: pkg["originBookingId"],
      venuePayment: { settlement: "FULL" },
    },
  });
  expect(settle.data["state"]).toBe("COMMITTED");
}
/** Customer UI redemption up to accepted session terms (existing lifecycle controls). */
async function prepareRedemptionInUi(progressId: string, service: string, dayOffset: number) {
  await page.goto(`${h.uiOrigin}/customer/packages/${progressId}?kind=first-class`);
  await page.waitFor(
    "document.querySelector('select[aria-label=\"Purchased service\"]')?.options.length > 1",
    120000,
  );
  await page.select("Purchased service", { text: service });
  await page.fill("input[aria-label='Session date']", day(dayOffset));
  await page.click("Find professionals and times");
  await page.waitFor(
    "document.querySelector('select[aria-label=\"Professional\"]').options.length > 1",
    60000,
  );
  await page.select("Professional", "first");
  await page.waitFor(
    "document.querySelector('select[aria-label=\"Appointment time\"]').options.length > 1",
  );
  await page.select("Appointment time", "first");
  await page.click("Review exact session terms");
  await page.waitFor("document.querySelector('[aria-label=\"Exact session disclosure\"]')", 60000);
  await page.check("I accept these exact independent session dues");
  await page.click("Accept session terms");
  await page.waitFor("document.body.innerText.includes('Confirm session booking')");
}
/** Customer UI redemption of one remaining session (existing lifecycle controls). */
async function redeemInUi(progressId: string, service: string, dayOffset: number) {
  await prepareRedemptionInUi(progressId, service, dayOffset);
  await page.click("Confirm session booking");
  await page.waitFor("document.body.innerText.includes('Server committed')", 120000);
}
/** The exact request the page froze for this Package (sessionStorage, same Customer). */
const retainedRedemption = (progressId: string) =>
  page.evaluate<{ key: string } | null>(`(() => {
  const key = Object.keys(sessionStorage).find((k) => k.startsWith("bookly:package-session:v1:") && k.endsWith(${JSON.stringify(`:${progressId}`)}));
  return key ? JSON.parse(sessionStorage.getItem(key)).request : null; })()`);
const claimFor = (operationId: string) =>
  BookingCreationClaimModel.findOne({
    idempotencyKey: `package-consent:${h.seed.customer.toHexString()}:${operationId}`,
  });

async function journey(name: string, body: () => Promise<void>) {
  try {
    await body();
    results.push({ journey: name, result: "PASS" });
  } catch (error) {
    results.push({ journey: name, result: "FAIL", detail: String(error).slice(0, 2000) });
    await page.screenshot(`${name.replace(/\W+/g, "-")}-failure.png`).catch(() => undefined);
    throw error;
  }
}

describe.skipIf(!enabled)("P4K isolated interactive First-Class Package browser journeys", () => {
  beforeAll(async () => {
    if (!artifacts || !clientRoot)
      throw Error("Explicit artifacts directory and client root required");
    await mkdir(artifacts, { recursive: true });
    if (readdirSync(artifacts).length) throw Error("Artifacts directory must be new and empty");
    h = await startP4kHarness();
    next = await startP4kClient({ clientRoot, apiOrigin: h.apiOrigin, uiOrigin: h.uiOrigin });
    page = await openP4kBrowser({
      artifacts,
      authenticate: (clientSecret, result) => simulateAuthentication({ clientSecret }, result),
    });
  }, 600000);
  afterAll(async () => {
    if (artifacts)
      await writeFile(
        join(artifacts, "p4k-browser-results.json"),
        JSON.stringify({ label: "ISOLATED SYNTHETIC", results }, null, 2),
      ).catch(() => undefined);
    page?.close();
    next?.stop();
    await h?.stop();
  });

  const v = () => h.seed.venue;
  let firstOperation = "",
    firstProgress = "",
    foreverProgress = "",
    finite6Progress = "";

  it(
    "1. successful Package Purchase (FINITE12, multi-service, add-on) creates verified ownership",
    async () =>
      journey("successful-purchase", async () => {
        await loginCustomerUi(
          h.seed.accounts.customer,
          consentUrl(v().id, v().packages.finite12._id),
        );
        const before = harnessGateway.createdPaymentIntentIds().length;
        firstOperation = await selectAndAccept([
          { service: "Hair", dayOffset: 3, addon: true },
          { service: "Facial", dayOffset: 4 },
        ]);
        await page.waitFor("document.body.innerText.includes('durable commit certified')");
        await page.click("Purchase this Package");
        await purchaseText();
        expect(await page.text()).toContain("Package purchase verified by the server");
        const claim = await claimFor(firstOperation).orFail();
        expect(claim.packageBatchCompletion?.version).toBe(2);
        const progress = await PackageProgressV2Model.findById(
          claim.packageBatchPreparation?.packageProgressId,
        ).orFail();
        firstProgress = String(progress._id);
        expect(
          await PackageConsentEvidenceModel.countDocuments({
            operationKey: claim.idempotencyKey,
            phase: "CERTIFICATION",
          }),
        ).toBe(1);
        expect(
          await PaymentAttemptModel.countDocuments({ logicalIdempotencyKey: claim.idempotencyKey }),
        ).toBeLessThanOrEqual(1);
        expect(harnessGateway.createdPaymentIntentIds().length - before).toBeLessThanOrEqual(1);
        await page.click("View verified Package");
        await page.waitFor("document.body.innerText.includes('Remaining')", 120000);
        const text = await page.text();
        expect(text).toContain("P4K FINITE12");
        expect(text).toContain("FINITE12");
        await page.screenshot("01-owned-detail.png");
        await page.screenshot("01-owned-detail-mobile.png", 390);
      }),
    900000,
  );

  it(
    "1b. at-home destination purchase retains the structured address and travel fee",
    async () =>
      journey("at-home-purchase", async () => {
        const t = h.seed.travel;
        await page.goto(consentUrl(t.id, t.packages.finite6._id));
        const operationId = await selectAndAccept([{ service: "Hair", dayOffset: 3 }], true);
        await page.click("Purchase this Package");
        await purchaseText();
        expect(await page.text()).toContain("Package purchase verified by the server");
        const claim = await claimFor(operationId).orFail();
        expect(claim.packageBatchCompletion?.version).toBe(2);
        const booking = await BookingModel.findOne({
          businessId: t.id,
          "customer.customerUserId": h.seed.customer,
        }).orFail();
        expect(JSON.stringify(booking.toObject())).toContain("Larnaca");
      }),
    900000,
  );

  it(
    "1c. venue page reflects server checkout availability and the exact Package definition",
    async () =>
      journey("venue-entry", async () => {
        const definition = v().packages.finite6;
        const detail = await api(`/package-views/catalog/${v().id}/${definition._id}`, {
          token: await token(h.seed.accounts.customer, "customer"),
        });
        const offer = (detail.data["packages"] as Array<Record<string, any>>)[0]!;
        // Server truth: availability comes from the isolated composition; quantities from the definition.
        expect(offer["checkoutAvailable"]).toBe(true);
        expect(offer["validity"]?.mode).toBe("FINITE");
        expect(offer["validity"]?.months).toBe(6);
        expect((offer["items"] as Array<{ quantity: number }>).map((i) => i.quantity)).toEqual(
          definition.items.map((i) => i.includedSessions),
        );
        expect(offer["bundlePriceCents"]).toBe(definition.bundlePriceCents);
        await page.goto(`${h.uiOrigin}/venue?id=${v().id}`);
        // The venue opens on "Featured"; Packages are listed under the existing Packages filter.
        const filter =
          "Array.from(document.querySelectorAll('[aria-label=\"Service filters\"] button')).find(b => b.textContent.trim() === 'Packages')";
        await page.waitFor(filter, 180000);
        await page.evaluate(`${filter}.click()`);
        const link = `document.querySelector('a[aria-label="View details of ${definition.name}"]')`;
        await page.waitFor(link, 180000);
        const card = await page.evaluate<string>(`${link}.closest('article').innerText`);
        expect(card).toContain("Checkout available");
        expect(card).not.toContain("Checkout unavailable");
        expect(card).toContain("3 total sessions");
        expect(card).toContain("FINITE6");
        await page.evaluate(`${link}.click()`);
        await page.waitFor(
          `location.pathname === ${JSON.stringify(new URL(consentUrl(v().id, definition._id)).pathname)}`,
          120000,
        );
        await page.waitFor(
          "Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('Add Hair appointment'))",
          120000,
        );
      }),
    600000,
  );

  it(
    "2. simulated 3DS continuation resumes the original attempt",
    async () =>
      journey("3ds-continuation", async () => {
        await page.goto(consentUrl(v().id, v().packages.forever._id));
        const operationId = await selectAndAccept([{ service: "Hair", dayOffset: 5 }]);
        harnessGateway.queueNextChargeOutcome("requires_action");
        const before = harnessGateway.createdPaymentIntentIds().length;
        await page.click("Purchase this Package");
        await purchaseText();
        expect(await page.text()).toContain("PAYMENT_PENDING");
        // A fake 3DS acknowledgement is not success: nothing is committed yet.
        expect((await claimFor(operationId).orFail()).packageBatchCompletion).toBeUndefined();
        await page.set3ds("succeeded");
        await page.click("Continue secure payment authentication");
        await page.waitFor(
          "document.body.innerText.includes('Package purchase verified by the server')",
          120000,
        );
        expect(harnessGateway.createdPaymentIntentIds().length - before).toBe(1);
        const claim = await claimFor(operationId).orFail();
        expect(claim.packageBatchCompletion?.version).toBe(2);
        foreverProgress = String(claim.packageBatchPreparation?.packageProgressId);
      }),
    900000,
  );

  it(
    "2b. manual in-page simulated 3DS challenge completes the same operation",
    async () =>
      journey("3ds-manual-dialog", async () => {
        await page.goto(consentUrl(v().id, v().packages.finite6._id));
        const operationId = await selectAndAccept([{ service: "Facial", dayOffset: 16 }]);
        harnessGateway.queueNextChargeOutcome("requires_action");
        const before = harnessGateway.createdPaymentIntentIds().length;
        await page.click("Purchase this Package");
        await purchaseText();
        expect(await page.text()).toContain("PAYMENT_PENDING");
        await page.set3ds("manual");
        await page.click("Continue secure payment authentication");
        await page.waitFor(
          "document.querySelector('[role=dialog][aria-label=\"Simulated 3DS challenge\"]')",
        );
        // The challenge alone changes nothing: no provider transition, no commit.
        expect((await claimFor(operationId).orFail()).packageBatchCompletion).toBeUndefined();
        await page.screenshot("02b-simulated-3ds-challenge.png");
        await page.click("Complete simulated authentication");
        await page.waitFor(
          "document.body.innerText.includes('Package purchase verified by the server')",
          120000,
        );
        expect(harnessGateway.createdPaymentIntentIds().length - before).toBe(1);
        const claim = await claimFor(operationId).orFail();
        expect(claim.packageBatchCompletion?.version).toBe(2);
        finite6Progress = String(claim.packageBatchPreparation?.packageProgressId);
        await page.set3ds("succeeded");
      }),
    900000,
  );

  it(
    "3. failed payment (decline and failed 3DS) leaves no usable entitlement",
    async () =>
      journey("failed-payment", async () => {
        await page.goto(consentUrl(v().id, v().packages.finite6._id));
        const declined = await selectAndAccept([{ service: "Facial", dayOffset: 6 }]);
        harnessGateway.queueNextChargeOutcome("failed");
        await page.click("Purchase this Package");
        await purchaseText();
        expect(await page.text()).toContain("Payment failed");
        const claim = await claimFor(declined).orFail();
        expect(claim.packageBatchCompletion).toBeUndefined();
        const progressId = claim.packageBatchPreparation?.packageProgressId;
        if (progressId)
          expect(await PackageProgressV2Model.countDocuments({ _id: progressId })).toBe(0);
        await page.goto(consentUrl(v().id, v().packages.finite6._id));
        const failed3ds = await selectAndAccept([{ service: "Hair", dayOffset: 7 }]);
        harnessGateway.queueNextChargeOutcome("requires_action");
        await page.click("Purchase this Package");
        await purchaseText();
        await page.set3ds("failed");
        await page.click("Continue secure payment authentication");
        await page.waitFor("document.querySelector('[role=alert]')");
        expect((await claimFor(failed3ds).orFail()).packageBatchCompletion).toBeUndefined();
        await page.set3ds("succeeded");
      }),
    900000,
  );

  it(
    "4. strict 30-minute consent deadline: late or uncertain trusted time fails closed",
    async () =>
      journey("strict-expiry", async () => {
        for (const clock of [
          { mode: "SKEW" as const, skewMs: 1800001 },
          { mode: "UNAVAILABLE" as const },
        ]) {
          await page.goto(consentUrl(v().id, v().packages.forever._id));
          // Quote is issued under NORMAL synthetic time; only the post-commit bound is late/unknown.
          setConsentClock({ mode: "NORMAL" });
          const operationId = await selectAndPresent([{ service: "Facial", dayOffset: 8 }]);
          setConsentClock(clock);
          await page.check("I have reviewed and agree");
          await page.click("Accept these terms");
          await page.waitFor(
            "document.body.innerText.includes('Terms accepted') || document.querySelector('[role=alert]')",
            120000,
          );
          const claim = await claimFor(operationId).orFail();
          expect(
            await PackageConsentEvidenceModel.countDocuments({
              operationKey: claim.idempotencyKey,
              phase: "CERTIFICATION",
            }),
          ).toBe(0);
          expect(await page.text()).not.toContain("durable commit certified");
          expect(
            await page.evaluate<boolean>(
              "Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Purchase this Package'))?.disabled ?? true",
            ),
          ).toBe(true);
          const direct = await api("/package-views/actions/purchase", {
            method: "POST",
            token: await token(h.seed.accounts.customer, "customer"),
            body: { businessId: String(v().id), operationId },
          });
          expect(direct.status).toBeGreaterThanOrEqual(400);
          expect(
            await PaymentAttemptModel.countDocuments({
              logicalIdempotencyKey: claim.idempotencyKey,
            }),
          ).toBe(0);
        }
        setConsentClock({ mode: "NORMAL" });
      }),
    900000,
  );

  it(
    "5. interrupted purchase (lost provider response) recovers the same operation after reload",
    async () =>
      journey("interrupted-recovery", async () => {
        await page.goto(consentUrl(v().id, v().packages.finite6._id));
        const operationId = await selectAndAccept([{ service: "Hair", dayOffset: 9 }]);
        harnessGateway.queueNextChargeLostResponse(Error("P4K simulated lost response"));
        const before = harnessGateway.createdPaymentIntentIds().length;
        await page.click("Purchase this Package");
        await page.waitFor(
          "document.body.innerText.includes('Purchase unconfirmed') || document.querySelector('[role=alert]')",
          120000,
        );
        await page.reload();
        await page.waitFor(
          "document.body.innerText.includes('Check original purchase status')",
          120000,
        );
        await page.click("Purchase this Package");
        await purchaseText();
        expect(await page.text()).toContain("Package purchase verified by the server");
        expect(harnessGateway.createdPaymentIntentIds().length - before).toBe(1);
        expect(
          await PaymentAttemptModel.countDocuments({
            logicalIdempotencyKey: (await claimFor(operationId).orFail()).idempotencyKey,
          }),
        ).toBe(1);
      }),
    900000,
  );

  it(
    "6. duplicate purchase of the same operation cannot create another purchase",
    async () =>
      journey("duplicate-prevention", async () => {
        const customer = await token(h.seed.accounts.customer, "customer");
        const before = {
          progress: await PackageProgressV2Model.countDocuments(),
          intents: harnessGateway.createdPaymentIntentIds().length,
        };
        const replies = await Promise.all(
          [0, 1, 2].map(() =>
            api("/package-views/actions/purchase", {
              method: "POST",
              token: customer,
              body: { businessId: String(v().id), operationId: firstOperation },
            }),
          ),
        );
        for (const reply of replies) {
          expect(reply.status).toBe(200);
          expect(reply.data["packageProgressId"]).toBe(firstProgress);
        }
        expect(await PackageProgressV2Model.countDocuments()).toBe(before.progress);
        expect(harnessGateway.createdPaymentIntentIds().length).toBe(before.intents);
      }),
    300000,
  );

  it(
    "7. member Bookings persist and appear in Customer and Staff views",
    async () =>
      journey("member-bookings", async () => {
        const customer = await token(h.seed.accounts.customer, "customer");
        const status = await api("/package-views/actions/purchase-status", {
          method: "POST",
          token: customer,
          body: { businessId: String(v().id), operationId: firstOperation },
        });
        const ids = (status.data["bookingIds"] as string[]).map((id) => new Types.ObjectId(id));
        const bookings = await BookingModel.find({ _id: { $in: ids } });
        expect(bookings).toHaveLength(2);
        for (const b of bookings) expect(String(b.businessId)).toBe(String(v().id));
        await page.goto(`${h.uiOrigin}/customer/bookings`);
        await page.waitFor("document.body.innerText.includes('Hair')", 120000);
        const staffMember = v().memberships.find((m) => m.role === "STAFF")!;
        const assigned = bookings.filter((b) =>
          b.serviceLines.some(
            (l) => String(l.responsibleStaffMembershipId) === String(staffMember.id),
          ),
        );
        const staff = await api(`/businesses/${v().id}/staff/me/appointments`, {
          token: await token(h.seed.accounts.staff, "professional"),
        });
        expect(staff.status).toBe(200);
        const listed = JSON.stringify(staff.data);
        for (const b of assigned) expect(listed).toContain(String(b._id));
      }),
    600000,
  );

  it(
    "8. credit redemption after Owner venue settlement consumes exactly one credit",
    async () =>
      journey("credit-redemption", async () => {
        await settleIfNeeded(firstProgress);
        const before = await PackageProgressV2Model.findById(firstProgress).orFail();
        const remainingBefore = before.items.reduce((n, i) => n + i.remainingSessions, 0);
        await redeemInUi(firstProgress, "Hair", 10);
        const after = await PackageProgressV2Model.findById(firstProgress).orFail();
        expect(after.items.reduce((n, i) => n + i.remainingSessions, 0)).toBe(remainingBefore - 1);
        await page.reload();
        await page.waitFor("document.body.innerText.includes('Remaining')", 120000);
      }),
    900000,
  );

  it(
    "9. session reschedule and cancellation commit through the purchased policy",
    async () =>
      journey("reschedule-cancel", async () => {
        await page.goto(`${h.uiOrigin}/customer/packages/${firstProgress}?kind=first-class`);
        await page.waitFor(
          "document.querySelectorAll('[aria-label=\"Package session actions\"]').length > 1",
          120000,
        );
        const sessions =
          "Array.from(document.querySelectorAll('[aria-label=\"Package session actions\"]')).filter(s => s.textContent.includes('Appointment '))";
        await page.evaluate(
          `(() => { const s = ${sessions}[0]; const sel = s.querySelector('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(sel,'reschedule'); sel.dispatchEvent(new Event('change',{bubbles:true})); })()`,
        );
        await page.fill("input[aria-label='New appointment date']", day(12));
        await page.click("Find new appointment times");
        await page.waitFor(
          "document.querySelector('select[aria-label=\"New appointment instant\"]').options.length > 1",
          60000,
        );
        await page.select("New appointment instant", "first");
        await page.evaluate(`${sessions}[0].querySelector('input[type=checkbox]').click()`);
        await page.evaluate(
          `Array.from(${sessions}[0].querySelectorAll('button')).find(b => b.textContent.includes('Submit package action')).click()`,
        );
        await page.waitFor(`${sessions}[0].innerText.includes('Server committed')`, 120000);
        await page.reload();
        await page.waitFor(`${sessions}.length > 0`, 120000);
        const bookingId = await page.evaluate<string>(
          `${sessions}.pop().textContent.match(/Appointment ([a-f0-9]{24})/)[1]`,
        );
        await page.evaluate(
          `(() => { const s = ${sessions}.pop(); s.querySelector('input[type=checkbox]').click(); })()`,
        );
        await page.evaluate(
          `Array.from(${sessions}.pop().querySelectorAll('button')).find(b => b.textContent.includes('Submit package action')).click()`,
        );
        await page.waitFor(`${sessions}.pop().innerText.includes('Server committed')`, 120000);
        expect((await BookingModel.findById(bookingId).orFail()).status).not.toBe("UPCOMING");
      }),
    900000,
  );

  it(
    "9b. owned Package detail shows server-derived counts that match persistence",
    async () =>
      journey("owned-counts", async () => {
        const owned = await api(`/package-views/owned/${firstProgress}`, {
          token: await token(h.seed.accounts.customer, "customer"),
        });
        const view = (owned.data["packages"] as Array<Record<string, any>>)[0]!;
        const progress = await PackageProgressV2Model.findById(firstProgress).orFail();
        const definition = v().packages.finite12;
        // Purchased quantities are the definition's, never altered by purchase or redemption.
        expect(progress.items.map((i) => i.totalSessions).sort()).toEqual(
          definition.items.map((i) => i.includedSessions).sort(),
        );
        for (const item of progress.items) expect(item.remainingSessions).toBeGreaterThanOrEqual(0);
        const persisted = progress.items
          .map((i) => [i.serviceSnapshot.name, i.totalSessions, i.remainingSessions])
          .sort();
        const shown = (view["items"] as Array<{ name: string; total: number; remaining: number }>)
          .map((i) => [i.name, i.total, i.remaining])
          .sort();
        expect(shown).toEqual(persisted);
        expect(view["purchaseCompletion"]).toBe("VERIFIED");
        expect(view["validity"]?.mode).toBe("FINITE");
        await page.goto(`${h.uiOrigin}/customer/packages/${firstProgress}?kind=first-class`);
        await page.waitFor("document.body.innerText.includes('Remaining')", 120000);
        const text = await page.text();
        expect(text).toContain(String(view["name"]));
        for (const [name] of persisted) expect(text).toContain(String(name));
      }),
    300000,
  );

  it(
    "9c. credit exhaustion and duplicate redemption cannot overspend",
    async () =>
      journey("credit-exhaustion", async () => {
        if (!foreverProgress) throw Error("Journey 2 did not produce the FOREVER Package");
        await settleIfNeeded(foreverProgress);
        const customer = await token(h.seed.accounts.customer, "customer");
        const before = await PackageProgressV2Model.findById(foreverProgress).orFail();
        const hair = before.items.find((i) => i.serviceSnapshot.name === "Hair")!;
        expect(hair.remainingSessions).toBe(0);
        expect(
          before.items.find((i) => i.serviceSnapshot.name === "Facial")!.remainingSessions,
        ).toBe(1);
        const exhausted = await api("/package-views/actions/selection", {
          method: "POST",
          token: customer,
          body: {
            businessId: String(v().id),
            packageProgressId: foreverProgress,
            packageItemId: String(hair.packageItemId),
            fromDate: day(18),
            toDate: day(18),
          },
        });
        expect(exhausted.status).toBe(409);
        await redeemInUi(foreverProgress, "Facial", 18);
        const after = await PackageProgressV2Model.findById(foreverProgress).orFail();
        expect(after.items.map((i) => i.remainingSessions)).toEqual([0, 0]);
        // Replay the exact committed request (same operation key): no second Booking or credit.
        const request = await page.evaluate<Record<string, unknown> | null>(`(() => {
      const key = Object.keys(sessionStorage).find((k) => k.startsWith("bookly:package-session:v1:") && k.endsWith(${JSON.stringify(`:${foreverProgress}`)}));
      return key ? JSON.parse(sessionStorage.getItem(key)).request : null; })()`);
        if (!request) throw Error("Committed redemption request not retained for replay");
        const bookings = () =>
          BookingModel.countDocuments({
            businessId: v().id,
            "customer.customerUserId": h.seed.customer,
          });
        const bookingsBefore = await bookings();
        const replay = await api("/package-views/actions/redeem", {
          method: "POST",
          token: customer,
          body: request,
        });
        if (replay.status === 200) expect(replay.data["state"]).toBe("COMMITTED");
        expect(await bookings()).toBe(bookingsBefore);
        expect(
          (await PackageProgressV2Model.findById(foreverProgress).orFail()).items.map(
            (i) => i.remainingSessions,
          ),
        ).toEqual([0, 0]);
        // Clear the retained (committed) request, then the exhausted Package offers no service.
        await page.click("Book another remaining session");
        await page.reload();
        await page.waitFor(
          "document.body.innerText.includes('Verified purchase, settled original balance and unexpired remaining credits are required')",
          120000,
        );
        expect(
          await page.evaluate<number>(
            "document.querySelector('select[aria-label=\"Purchased service\"]').options.length",
          ),
        ).toBe(1);
      }),
    900000,
  );

  it(
    "9d. committed redemption survives reload and a lost response without a second Booking",
    async () =>
      journey("redemption-recovery", async () => {
        if (!finite6Progress) throw Error("Journey 2b did not produce the FINITE6 Package");
        await settleIfNeeded(finite6Progress);
        const progressOf = async () =>
          (await PackageProgressV2Model.findById(finite6Progress).orFail()).items.find(
            (i) => i.serviceSnapshot.name === "Hair",
          )!.remainingSessions;
        const bookings = () =>
          BookingModel.countDocuments({
            businessId: v().id,
            "customer.customerUserId": h.seed.customer,
          });
        const committedBooking = async (key: string) => {
          const operation = await PackageLifecycleOperationModel.findById(
            lifecycleOperationId(key),
          ).orFail();
          expect(operation.phase).toBe("COMPLETE");
          return String(operation.bookingId);
        };
        const shownBooking = () =>
          page.evaluate<string>(
            "(document.body.innerText.match(/Server committed: [A-Z_]+ · Booking ([a-f0-9]{24})/) || [])[1] || ''",
          );
        const hairBefore = await progressOf();
        expect(hairBefore).toBe(2);

        // A. Ordinary commit, then reload: the page asks session-status and shows the same Booking.
        const bookingsBefore = await bookings();
        await redeemInUi(finite6Progress, "Hair", 20);
        const first = await retainedRedemption(finite6Progress);
        if (!first) throw Error("Redemption request not retained");
        const firstBooking = await committedBooking(first.key);
        expect(await shownBooking()).toBe(firstBooking);
        expect(await progressOf()).toBe(hairBefore - 1);
        expect(await bookings()).toBe(bookingsBefore + 1);
        await page.reload();
        await page.waitFor("document.body.innerText.includes('Server committed')", 120000);
        expect(await page.text()).not.toContain("Operation unresolved");
        expect(await shownBooking()).toBe(firstBooking);
        expect(await progressOf()).toBe(hairBefore - 1);
        expect(await bookings()).toBe(bookingsBefore + 1);
        await page.click("Book another remaining session");

        // B. Lost response after the server committed: the page cannot know; reload recovers it.
        await prepareRedemptionInUi(finite6Progress, "Hair", 22);
        const second = await retainedRedemption(finite6Progress);
        if (!second) throw Error("Second redemption request not retained");
        await page.dropNextResponse("/package-views/actions/redeem");
        await page.click("Confirm session booking");
        await page.waitFor("document.querySelector('[role=alert]')", 120000);
        expect(await page.text()).not.toContain("Server committed");
        const secondBooking = await committedBooking(second.key);
        expect(await progressOf()).toBe(hairBefore - 2);
        expect(await bookings()).toBe(bookingsBefore + 2);
        await page.reload();
        await page.waitFor("document.body.innerText.includes('Server committed')", 120000);
        expect(await shownBooking()).toBe(secondBooking);
        // Recovery is read-only: same key, no second Booking, no further credit.
        expect((await retainedRedemption(finite6Progress))?.key).toBe(second.key);
        expect(await progressOf()).toBe(0);
        expect(await bookings()).toBe(bookingsBefore + 2);
        await page.click("Book another remaining session");

        // C. Another Customer cannot read this operation's status.
        const other = await api("/package-views/actions/session-status", {
          method: "POST",
          token: await token(h.seed.accounts.otherCustomer, "customer"),
          body: second,
        });
        expect(other.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(other.data)).not.toContain(secondBooking);
      }),
    900000,
  );

  it(
    "9e. committed reschedule and cancellation survive reload and lost responses without repeating",
    async () =>
      journey("cancel-reschedule-recovery", async () => {
        // Fresh FINITE12 (Hair3 Facial2 Yoga1) with a Hair initial appointment: Hair 2 remaining.
        await page.goto(consentUrl(v().id, v().packages.finite12._id));
        const operationId = await selectAndAccept([{ service: "Hair", dayOffset: 23 }]);
        await page.click("Purchase this Package");
        await purchaseText();
        expect(await page.text()).toContain("Package purchase verified by the server");
        const progressId = String(
          (await claimFor(operationId).orFail()).packageBatchPreparation?.packageProgressId,
        );
        await settleIfNeeded(progressId);
        const bookingOf = async (key: string) =>
          String(
            (await PackageLifecycleOperationModel.findById(lifecycleOperationId(key)).orFail())
              .bookingId,
          );
        const redeemHair = async (dayOffset: number) => {
          await redeemInUi(progressId, "Hair", dayOffset);
          const request = await retainedRedemption(progressId);
          if (!request) throw Error("Redemption request not retained");
          const bookingId = await bookingOf(request.key);
          await page.click("Book another remaining session");
          return bookingId;
        };
        const x = await redeemHair(24),
          y = await redeemHair(25);
        const hair = async () =>
          (await PackageProgressV2Model.findById(progressId).orFail()).items.find(
            (i) => i.serviceSnapshot.name === "Hair",
          )!.remainingSessions;
        expect(await hair()).toBe(0);
        const snapshot = async () => ({
          bookings: await BookingModel.countDocuments({
            businessId: v().id,
            "customer.customerUserId": h.seed.customer,
          }),
          reservations: await BookingSlotReservationModel.countDocuments(),
          operations: await PackageLifecycleOperationModel.countDocuments(),
          hair: await hair(),
        });
        const detail = `${h.uiOrigin}/customer/packages/${progressId}?kind=first-class`;
        const section = (bookingId: string) =>
          `Array.from(document.querySelectorAll('[aria-label="Package session actions"]')).find((s) => s.textContent.includes(${JSON.stringify(`Appointment ${bookingId}`)}))`;
        const inSection = (bookingId: string, body: string) =>
          page.evaluate(
            `(() => { const s = ${section(bookingId)}; if (!s) throw Error("No session section"); ${body} })()`,
          );
        const setValue = (
          selector: string,
          value: string,
          proto: "HTMLSelectElement" | "HTMLInputElement",
        ) =>
          `{ const el = s.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(${proto}.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(${JSON.stringify(proto === "HTMLSelectElement" ? "change" : "input")}, { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }`;
        const press = (bookingId: string, label: string) =>
          inSection(
            bookingId,
            `const b = Array.from(s.querySelectorAll("button")).find((e) => e.textContent.includes(${JSON.stringify(label)})); if (!b || b.disabled) throw Error("Unavailable: ${label}"); b.click();`,
          );
        const confirmAndSubmit = async (bookingId: string) => {
          await inSection(
            bookingId,
            `const c = s.querySelector('input[type=checkbox]'); if (!c.checked) c.click();`,
          );
          await press(bookingId, "Submit package action");
        };
        const reschedule = async (bookingId: string, dayOffset: number) => {
          await page.waitFor(section(bookingId), 120000);
          await inSection(
            bookingId,
            setValue(
              'select[aria-label="Package session action"]',
              "reschedule",
              "HTMLSelectElement",
            ),
          );
          await inSection(
            bookingId,
            setValue(
              'input[aria-label="New appointment date"]',
              day(dayOffset),
              "HTMLInputElement",
            ),
          );
          await press(bookingId, "Find new appointment times");
          await page.waitFor(
            `${section(bookingId)}?.querySelector('select[aria-label="New appointment instant"]').options.length > 1`,
            60000,
          );
          const instant = await page.evaluate<string>(
            `${section(bookingId)}.querySelector('select[aria-label="New appointment instant"]').options[1].value`,
          );
          await inSection(
            bookingId,
            setValue('select[aria-label="New appointment instant"]', instant, "HTMLSelectElement"),
          );
          await confirmAndSubmit(bookingId);
          return instant;
        };
        const retainedAction = (bookingId: string) =>
          page.evaluate<Record<string, unknown> | null>(`(() => {
      const key = Object.keys(sessionStorage).find((k) => k.startsWith("bookly:package-action:v1:") && k.endsWith(${JSON.stringify(`:${progressId}:${bookingId}:false`)}));
      return key ? JSON.parse(sessionStorage.getItem(key)).input : null; })()`);
        const startOf = async (bookingId: string) =>
          (await BookingModel.findById(bookingId).orFail()).schedule.startAt.toISOString();

        // A. Committed reschedule, then reload: reschedule-status shows the same committed move.
        await page.goto(detail);
        const firstMove = await reschedule(x, 27);
        await page.waitFor(`${section(x)}?.innerText.includes('Server committed')`, 120000);
        expect(await startOf(x)).toBe(new Date(firstMove).toISOString());
        const afterMove = await snapshot();
        await page.reload();
        await page.waitFor(`${section(x)}?.innerText.includes('Server committed')`, 120000);
        expect(await page.evaluate<string>(`${section(x)}.innerText`)).not.toContain(
          "Operation unresolved",
        );
        expect(await snapshot()).toEqual(afterMove);
        await press(x, "Choose another action");

        // B. Lost reschedule response after commit: reload recovers it, nothing is repeated.
        await page.dropNextResponse("/package-views/actions/reschedule");
        const secondMove = await reschedule(x, 28);
        await page.waitFor(`${section(x)}?.querySelector('[role=alert]')`, 120000);
        expect(await page.evaluate<string>(`${section(x)}.innerText`)).not.toContain(
          "Server committed",
        );
        const lostMove = await retainedAction(x);
        if (!lostMove) throw Error("Reschedule request not retained");
        expect(
          (
            await PackageLifecycleOperationModel.findById(
              lifecycleOperationId(String(lostMove["key"])),
            ).orFail()
          ).phase,
        ).toBe("COMPLETE");
        expect(await startOf(x)).toBe(new Date(secondMove).toISOString());
        const afterLostMove = await snapshot();
        await page.reload();
        await page.waitFor(`${section(x)}?.innerText.includes('Server committed')`, 120000);
        expect((await retainedAction(x))?.["key"]).toBe(lostMove["key"]);
        expect(await snapshot()).toEqual(afterLostMove);
        await press(x, "Choose another action");

        // C. Lost cancellation response: credit restored exactly once; the reloaded Package shows the
        // cancelled session (its action control is for upcoming sessions only) and status confirms it.
        await page.dropNextResponse("/package-views/actions/cancel");
        await page.waitFor(section(y), 120000);
        await confirmAndSubmit(y);
        await page.waitFor(`${section(y)}?.querySelector('[role=alert]')`, 120000);
        const lostCancel = await retainedAction(y);
        if (!lostCancel) throw Error("Cancellation request not retained");
        expect((await BookingModel.findById(y).orFail()).status).not.toBe("UPCOMING");
        expect(await hair()).toBe(1);
        const afterCancel = await snapshot();
        await page.reload();
        await page.waitFor("document.body.innerText.includes('Session history')", 120000);
        // P4K-5: the retained request for Y (no longer upcoming) is checked once, read-only, and
        // retired only because the server proves the committed cancellation.
        await page.waitFor(
          `!${section(y)} && !Object.keys(sessionStorage).some((k) => k.endsWith(${JSON.stringify(`:${progressId}:${y}:false`)}))`,
          120000,
        );
        expect(await snapshot()).toEqual(afterCancel);
        const customer = await token(h.seed.accounts.customer, "customer");
        for (let i = 0; i < 2; i++) {
          const status = await api("/package-views/actions/cancel-status", {
            method: "POST",
            token: customer,
            body: lostCancel,
          });
          expect(status.status).toBe(200);
          expect(status.data["state"]).toBe("COMMITTED");
        }
        expect(await snapshot()).toEqual(afterCancel);

        // D. Committed cancellation of the moved Booking, then reload: one more credit, no repeat.
        await page.waitFor(section(x), 120000);
        await confirmAndSubmit(x);
        await page.waitFor(
          `!${section(x)} || ${section(x)}.innerText.includes('Server committed')`,
          120000,
        );
        expect(await hair()).toBe(2);
        const afterSecondCancel = await snapshot();
        await page.reload();
        await page.waitFor("document.body.innerText.includes('Session history')", 120000);
        expect(await snapshot()).toEqual(afterSecondCancel);

        // E. Another Customer cannot read either operation.
        const other = await token(h.seed.accounts.otherCustomer, "customer");
        for (const [action, body] of [
          ["cancel-status", lostCancel],
          ["reschedule-status", lostMove],
        ] as const) {
          const denied = await api(`/package-views/actions/${action}`, {
            method: "POST",
            token: other,
            body,
          });
          expect(denied.status).toBeGreaterThanOrEqual(400);
          expect(JSON.stringify(denied.data)).not.toContain(x);
          expect(JSON.stringify(denied.data)).not.toContain(y);
        }
      }),
    1200000,
  );

  it(
    "9f. Owner/Supervisor management actions recover read-only after a lost response (API level)",
    async () =>
      journey("management-recovery", async () => {
        // Customer purchase and redemption through the real UI; management actions through the
        // shipped HTTP routes with real Owner/Supervisor sessions (the Owner dashboard UI path is not
        // driven by this suite). A "lost response" is a committed request whose reply is discarded.
        await page.goto(consentUrl(v().id, v().packages.forever._id));
        const operationId = await selectAndAccept([{ service: "Hair", dayOffset: 30 }]);
        await page.click("Purchase this Package");
        await purchaseText();
        expect(await page.text()).toContain("Package purchase verified by the server");
        const claim = await claimFor(operationId).orFail();
        const progressId = String(claim.packageBatchPreparation?.packageProgressId);
        const origin = String(claim.packageBatchPreparation?.originBookingId);
        const owner = await token(h.seed.accounts.owner, "professional");
        const supervisor = await token(h.seed.accounts.supervisor, "professional");
        const snapshot = async () => ({
          ledger: await BookingFinancialTransactionModel.countDocuments({ businessId: v().id }),
          operations: await PackageLifecycleOperationModel.countDocuments(),
          bookings: (await BookingModel.find({ businessId: v().id }).sort({ _id: 1 }).lean()).map(
            (b) => [String(b._id), b.status],
          ),
          progress: (await PackageProgressV2Model.findById(progressId).orFail()).items.map((i) => [
            i.remainingSessions,
            i.completedSessions,
          ]),
        });
        const scope = { businessId: String(v().id), packageProgressId: progressId };

        // Owner venue settlement: status proves the exact committed settlement, never settles again.
        const settlement = {
          ...scope,
          key: randomUUID(),
          bookingId: origin,
          venuePayment: { settlement: "FULL" },
        };
        const settled = await api("/package-views/actions/settlement", {
          method: "POST",
          token: owner,
          body: settlement,
        });
        if (settled.status === 200) {
          const afterSettlement = await snapshot();
          for (let i = 0; i < 2; i++) {
            const status = await api("/package-views/actions/settlement-status", {
              method: "POST",
              token: owner,
              body: settlement,
            });
            expect(status.status).toBe(200);
            expect(status.data["state"]).toBe("COMMITTED");
          }
          expect(await snapshot()).toEqual(afterSettlement);
        }

        // Completion-routing regression: use the real Calendar projection and ordinary HTTP
        // boundary with the harness authority open. Dashboard clicks are covered by Client tests.
        const member = await BookingModel.findById(origin).orFail();
        const from = encodeURIComponent(
          new Date(member.schedule.startAt.getTime() - 1).toISOString(),
        );
        const to = encodeURIComponent(
          new Date(member.schedule.startAt.getTime() + 1).toISOString(),
        );
        const calendar = await api(
          `/businesses/${v().id}/bookings/calendar?fromDate=${from}&toDate=${to}`,
          { token: owner },
        );
        expect(calendar.status).toBe(200);
        expect(
          (calendar.data["bookings"] as Array<{ id: string; firstClassPackage: boolean }>).find(
            (row) => row.id === origin,
          )?.firstClassPackage,
        ).toBe(true);
        const beforeOrdinary = await snapshot();
        const ordinary = await api(`/businesses/${v().id}/bookings/${origin}/complete`, {
          method: "POST",
          token: owner,
          body: { venuePayment: { settlement: "FULL" } },
        });
        expect(ordinary.status).toBe(409);
        expect(await snapshot()).toEqual(beforeOrdinary);
        expect(
          (await PackageProgressV2Model.findById(progressId).orFail()).sessions.find(
            (attempt) => String(attempt.bookingId) === origin,
          )?.status,
        ).toBe("SCHEDULED");

        // Owner completion whose response is "lost": status recovers the same committed result.
        const complete = { ...scope, key: randomUUID(), bookingId: origin };
        await api("/package-views/actions/complete", {
          method: "POST",
          token: owner,
          body: complete,
        }); // reply discarded
        const afterComplete = await snapshot();
        const recovered = await api("/package-views/actions/complete-status", {
          method: "POST",
          token: owner,
          body: complete,
        });
        expect(recovered.status).toBe(200);
        expect(recovered.data["state"]).toBe("COMMITTED");
        expect(await snapshot()).toEqual(afterComplete);
        expect((await BookingModel.findById(origin).orFail()).status).toBe("COMPLETED");
        expect(
          (await PackageProgressV2Model.findById(progressId).orFail()).sessions.find(
            (attempt) => String(attempt.bookingId) === origin,
          )?.status,
        ).toBe("COMPLETED");
        expect(
          (
            await api("/package-views/actions/complete", {
              method: "POST",
              token: owner,
              body: complete,
            })
          ).status,
        ).toBe(200);
        expect(await snapshot()).toEqual(afterComplete);

        // Supervisor cancels a redeemed session; each actor reads only its own operation.
        await settleIfNeeded(progressId);
        await redeemInUi(progressId, "Facial", 31);
        const request = await retainedRedemption(progressId);
        if (!request) throw Error("Redemption request not retained");
        const facial = String(
          (
            await PackageLifecycleOperationModel.findById(
              lifecycleOperationId(request.key),
            ).orFail()
          ).bookingId,
        );
        const cancel = { ...scope, key: randomUUID(), bookingId: facial };
        expect(
          (
            await api("/package-views/actions/cancel", {
              method: "POST",
              token: supervisor,
              body: cancel,
            })
          ).status,
        ).toBe(200);
        const afterCancel = await snapshot();
        expect(
          (
            await api("/package-views/actions/cancel-status", {
              method: "POST",
              token: supervisor,
              body: cancel,
            })
          ).data["state"],
        ).toBe("COMMITTED");
        expect(
          (
            await api("/package-views/actions/cancel-status", {
              method: "POST",
              token: owner,
              body: cancel,
            })
          ).status,
        ).toBe(404);
        expect(
          (
            await api("/package-views/actions/complete-status", {
              method: "POST",
              token: supervisor,
              body: complete,
            })
          ).status,
        ).toBe(404);

        // Unauthorized roles and a foreign Business learn nothing.
        const denials = [
          ["complete-status", await token(h.seed.accounts.staff, "professional"), complete],
          ["complete-status", await token(h.seed.accounts.customer, "customer"), complete],
          ["cancel-status", await token(h.seed.accounts.travelOwner, "professional"), cancel],
          [
            "settlement-status",
            await token(h.seed.accounts.travelOwner, "professional"),
            settlement,
          ],
        ] as const;
        for (const [action, actor, body] of denials) {
          const denied = await api(`/package-views/actions/${action}`, {
            method: "POST",
            token: actor,
            body,
          });
          expect(denied.status).toBeGreaterThanOrEqual(400);
          expect(JSON.stringify(denied.data)).not.toContain("COMMITTED");
        }
        expect(await snapshot()).toEqual(afterCancel);
      }),
    900000,
  );

  it(
    "10. cross-role and cross-tenant authorization denials",
    async () =>
      journey("cross-role-denial", async () => {
        const other = await token(h.seed.accounts.otherCustomer, "customer");
        const staff = await token(h.seed.accounts.staff, "professional");
        const supervisor = await token(h.seed.accounts.supervisor, "professional");
        const travelOwner = await token(h.seed.accounts.travelOwner, "professional");
        const progress = await PackageProgressV2Model.findById(firstProgress).orFail();
        const origin = String(progress.originBookingId);
        expect(
          (await api(`/package-views/owned/${firstProgress}`, { token: other })).status,
        ).toBeGreaterThanOrEqual(400);
        expect(
          (
            await api("/package-views/actions/purchase-status", {
              method: "POST",
              token: other,
              body: { businessId: String(v().id), operationId: firstOperation },
            })
          ).status,
        ).toBeGreaterThanOrEqual(400);
        for (const action of ["cancel", "complete", "settlement"])
          expect(
            (
              await api(`/package-views/actions/${action}`, {
                method: "POST",
                token: staff,
                body: {
                  businessId: String(v().id),
                  packageProgressId: firstProgress,
                  key: randomUUID(),
                  bookingId: origin,
                },
              })
            ).status,
          ).toBe(403);
        expect(
          (await api(`/package-views/settlement/${v().id}/${origin}`, { token: staff })).status,
        ).toBe(403);
        expect(
          (await api(`/package-views/settlement/${v().id}/${origin}`, { token: supervisor }))
            .status,
        ).toBe(200);
        expect(
          (await api(`/package-views/settlement/${v().id}/${origin}`, { token: travelOwner }))
            .status,
        ).toBeGreaterThanOrEqual(400);
        const customer = await token(h.seed.accounts.customer, "customer");
        expect(
          (
            await api("/package-views/actions/complete", {
              method: "POST",
              token: customer,
              body: {
                businessId: String(v().id),
                packageProgressId: firstProgress,
                key: randomUUID(),
                bookingId: origin,
              },
            })
          ).status,
        ).toBe(403);
        // Business-initiated Package redemption remains unapproved (D-P1).
        expect(
          (
            await api("/package-views/actions/redeem", {
              method: "POST",
              token: supervisor,
              body: {
                businessId: String(v().id),
                packageProgressId: firstProgress,
                key: randomUUID(),
              },
            })
          ).status,
        ).toBeGreaterThanOrEqual(400);
      }),
    300000,
  );

  it(
    "11. unlink/relink invalidates pending Purchase-status recovery",
    async () =>
      journey("unlink-relink-denial", async () => {
        await page.goto(consentUrl(v().id, v().packages.finite6._id));
        const operationId = await selectAndAccept([{ service: "Hair", dayOffset: 13 }]);
        harnessGateway.queueNextChargeOutcome("requires_action");
        await page.click("Purchase this Package");
        await purchaseText();
        expect(await page.text()).toContain("PAYMENT_PENDING");
        const client = await BusinessClientModel.findOne({
          businessId: v().id,
          linkedUserId: h.seed.customer,
        }).orFail();
        const clients = new ClientRepository();
        await clients.setLinkState(client._id, { linkState: "UNLINKED" });
        await clients.setLinkState(client._id, {
          linkState: "LINKED",
          linkedUserId: h.seed.customer,
        });
        const status = await api("/package-views/actions/purchase-status", {
          method: "POST",
          token: await token(h.seed.accounts.customer, "customer"),
          body: { businessId: String(v().id), operationId },
        });
        expect(status.status).toBe(409);
        expect(JSON.stringify(status.data)).not.toContain("clientSecret");
        await page.click("Check original purchase status");
        await page.waitFor("document.querySelector('[role=alert]')");
        expect((await claimFor(operationId).orFail()).packageBatchCompletion).toBeUndefined();
      }),
    900000,
  );

  it(
    "12. ordinary (non-Package) Booking regression on the same harness",
    async () =>
      journey("ordinary-booking", async () => {
        const other = await token(h.seed.accounts.otherCustomer, "customer");
        const staffMember = v().memberships.find((m) => m.role === "STAFF")!;
        const slots = await api(
          `/catalog/businesses/${v().id}/services/${v().services.hair}/availability?fromDate=${day(15)}&toDate=${day(15)}&staffMembershipId=${staffMember.id}&partySize=1`,
          { token: other },
        );
        expect(slots.status).toBe(200);
        const startAt = (
          slots.data["days"] as Array<{ slots: Array<{ startAt: string }> }>
        ).flatMap((d) => d.slots)[0]?.startAt;
        if (!startAt) throw Error("No ordinary availability");
        const body = {
          serviceLines: [
            { serviceId: String(v().services.hair), staffMembershipId: String(staffMember.id) },
          ],
          startAt,
          idempotencyKey: randomUUID(),
        };
        expect(
          (
            await api(`/businesses/${v().id}/bookings/preview`, {
              method: "POST",
              token: other,
              body,
            })
          ).status,
        ).toBe(200);
        const finalized = await api(`/businesses/${v().id}/bookings/finalize`, {
          method: "POST",
          token: other,
          body,
        });
        // Customer B has no saved card: the shipped ordinary path must refuse or create an
        // ordinary Booking — never a Package entitlement.
        expect([200, 201, 400, 402, 409, 422]).toContain(finalized.status);
        expect(
          await PackageProgressV2Model.countDocuments({ customerUserId: h.seed.otherCustomer }),
        ).toBe(0);
      }),
    300000,
  );
});
