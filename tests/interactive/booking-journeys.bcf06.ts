import { randomUUID } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AddonServiceAssignmentModel } from "../../src/modules/addons/addon-service-assignment.model.js";
import { AppointmentReminderModel } from "../../src/modules/appointment-reminder/appointment-reminder.model.js";
import { BookingModel } from "../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../src/modules/booking/booking.repository.js";
import { NoShowResolutionService } from "../../src/modules/booking/no-show-resolution.service.js";
import { createPenaltyCollectionService } from "../../src/modules/booking/penalty-collection.factory.js";
import { BookingFinancialTransactionModel } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
import { BookingFinancialTransactionRepository } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { BookingSlotReservationModel } from "../../src/modules/booking-slot-reservation/booking-slot-reservation.model.js";
import { BookingSlotReservationClaimModel } from "../../src/modules/booking-slot-reservation/booking-slot-reservation-claim.model.js";
import { BusinessRepository } from "../../src/modules/business/business.repository.js";
import { EmailOutboxModel } from "../../src/modules/email-outbox/email-outbox.model.js";
import { PackageProgressModel } from "../../src/modules/package-progress/package-progress.model.js";
import { CustomerPaymentProfileRepository } from "../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../src/modules/payment/payment.service.js";
import { PaymentAttemptModel } from "../../src/modules/payment/payment-attempt.model.js";
import { PromoCodeModel } from "../../src/modules/promo/promo.model.js";
import { ServiceModel } from "../../src/modules/services/service.model.js";
import { SessionModel } from "../../src/modules/session/session.model.js";
import { StaffMembershipModel } from "../../src/modules/staff/staff.model.js";
import { UserRepository } from "../../src/modules/user/user.repository.js";
import { openP4kBrowser, type P4kPage } from "./p4k-browser.js";
import { type P4kClient, startP4kClient } from "./p4k-client.js";
import { type P4kHarness, startP4kHarness } from "./p4k-harness.js";
import { harnessGateway, simulateAuthentication } from "./p4k-harness-state.js";
import { seedP4kPaymentVenue } from "./p4k-seed.js";

const artifacts = process.env["BOOKLY_P4K_BROWSER_ARTIFACTS"]!;
const clientRoot = process.env["BOOKLY_P4K_CLIENT_ROOT"]!;
let hourlyId = "",
  legacyId = "";
let firstId = "",
  returningId = "",
  packageId = "";
let h: P4kHarness, page: P4kPage, ownerPage: P4kPage, next: P4kClient;
const initialClock = "2026-11-02T08:00:00.000Z";
const results: unknown[] = [];
async function journey(name: string, run: () => Promise<void>) {
  try {
    // Each journey starts with a freshly authenticated Customer browser context. The
    // initial A1 path below exercises the Customer login UI before the same session
    // is re-established across the harness's full-document navigation boundary.
    if (name !== "A1") {
      await Promise.all([page.clearStorage(), ownerPage.clearStorage()]);
      // The final travel redemption follows B5, which advances synthetic time. Reset only this
      // terminal journey so it can use a fresh service window without collapsing timestamps
      // across earlier journeys that assert the newest booking.
      if (name === "C4-travel") {
        vi.setSystemTime(new Date(initialClock));
        await Promise.all([page.setClock(initialClock), ownerPage.setClock(initialClock)]);
      }
      await session(page, h.seed.accounts.customer, "customer", "/customer/bookings");
    }
    await run();
    results.push({ name, result: "PASS" });
  } catch (error) {
    results.push({ name, result: "FAIL", error: String(error) });
    await writeFile(join(artifacts, `${name}-failure.txt`), await page.text());
    await page.screenshot(`${name}-failure.png`);
    await writeFile(join(artifacts, `${name}-owner-failure.txt`), await ownerPage.text());
    await ownerPage.screenshot(`${name}-owner-failure.png`);
    throw error;
  } finally {
    await writeFile(
      join(artifacts, `${name}-network.json`),
      JSON.stringify({ customer: page.network(), business: ownerPage.network() }, null, 2),
    );
    await writeFile(
      join(artifacts, `${name}-browser-errors.json`),
      JSON.stringify(
        { customer: page.browserErrors(), business: ownerPage.browserErrors() },
        null,
        2,
      ),
    );
    await writeFile(join(artifacts, "results.json"), JSON.stringify(results, null, 2));
  }
}
async function api(path: string, token: string) {
  const r = await fetch(`${h.apiOrigin}/api/v1${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: r.status, body: (await r.json()) as { data: Record<string, any> } };
}
async function token(email: string, kind = "customer") {
  const r = await fetch(`${h.apiOrigin}/api/v1/auth/${kind}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: h.seed.password }),
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { data: { accessToken: string } }).data.accessToken as string;
}
async function post(path: string, auth: string, body: unknown = {}) {
  const r = await fetch(`${h.apiOrigin}/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as { data: Record<string, any> } };
}
async function session(p: P4kPage, email: string, kind: string, target: string) {
  await p.goto(`${h.uiOrigin}/select-role`);
  const status = await p.evaluate<number>(
    `fetch(${JSON.stringify(`${h.apiOrigin}/api/v1/auth/${kind}/login`)},{method:"POST",credentials:"include",headers:{"content-type":"application/json"},body:JSON.stringify(${JSON.stringify({ email, password: "P4k-Synthetic-Only-123!" })})}).then(r=>r.status)`,
  );
  expect(status).toBe(200);
  await p.goto(`${h.uiOrigin}${target}`);
  if (kind === "customer" && target === "/customer/bookings") {
    // Wait for the actual authenticated route to hydrate before a later navigation can
    // interrupt its refresh-cookie bootstrap.
    await p.waitFor(
      "location.pathname === '/customer/bookings' && document.body.innerText.includes('My Bookings')",
      120000,
    );
  }
}
async function crossRole(bookingId: string, businessId = String(h.seed.venue.id)) {
  const customer = await api(`/me/bookings/${bookingId}`, await token(h.seed.accounts.customer));
  const owner = await api(
    `/businesses/${businessId}/bookings/${bookingId}`,
    await token(h.seed.accounts.owner, "professional"),
  );
  const supervisor = await api(
    `/businesses/${businessId}/bookings/${bookingId}`,
    await token(h.seed.accounts.supervisor, "professional"),
  );
  const foreign = await api(
    `/me/bookings/${bookingId}`,
    await token(h.seed.accounts.otherCustomer),
  );
  const foreignBusiness = await api(
    `/businesses/${businessId}/bookings/${bookingId}`,
    await token(h.seed.accounts.travelOwner, "professional"),
  );
  expect(customer.status).toBe(200);
  expect(owner.status).toBe(200);
  expect(supervisor.status).toBe(200);
  expect(foreign.status).toBe(404);
  expect([403, 404]).toContain(foreignBusiness.status);
  expect(customer.body.data["status"]).toBe(owner.body.data["status"]);
  expect(customer.body.data["schedule"]).toEqual(owner.body.data["schedule"]);
  await writeFile(
    join(artifacts, `${bookingId}-roles.json`),
    JSON.stringify(
      {
        customer: customer.body.data,
        owner: owner.body.data,
        supervisorStatus: supervisor.status,
        foreignStatus: foreign.status,
        foreignBusinessStatus: foreignBusiness.status,
      },
      null,
      2,
    ),
  );
  const persisted = await BookingModel.findById(bookingId).orFail();
  const emails = await EmailOutboxModel.find({ eventKey: { $regex: bookingId } })
    .select("eventKey templateKey status dedupeKey")
    .lean();
  expect(emails.some((e) => e.eventKey === `BOOKING_CREATED:${bookingId}`)).toBe(true);
  const reminders = await AppointmentReminderModel.find({ bookingId }).lean();
  const ledger = await BookingFinancialTransactionModel.find({ bookingId }).lean();
  const attempts = await PaymentAttemptModel.find({ bookingId })
    .select(
      "logicalIdempotencyKey expectedAmountCents providerStatus persistenceStatus compensationStatus",
    )
    .lean();
  const claims = await BookingSlotReservationClaimModel.find({
    reservationId: { $in: persisted.serviceLines.map((l) => l.reservationId) },
  }).lean();
  await writeFile(
    join(artifacts, `${bookingId}-durability.json`),
    JSON.stringify({ booking: persisted, emails, reminders, ledger, attempts, claims }, null, 2),
  );
  return customer.body.data;
}
async function lastBooking(venueId = h.seed.venue.id) {
  return BookingModel.findOne({ businessId: venueId, "customer.customerUserId": h.seed.customer })
    .sort({ createdAt: -1, _id: -1 })
    .orFail();
}
async function cardAction(p: P4kPage, reference: string, action: string) {
  await p.evaluate(
    `(() => { let node=Array.from(document.querySelectorAll('span')).find(e=>e.textContent===${JSON.stringify(reference)}); while(node) { const b=Array.from(node.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(action)});if(b){b.click();return;}node=node.parentElement;} throw Error('No booking card action'); })()`,
  );
}
async function openOwnerBooking(booking: { reference: string }) {
  await ownerPage.goto(`${h.uiOrigin}/business-dashboard?section=all-bookings`);
  await ownerPage.waitFor(
    `Array.from(document.querySelectorAll('tr')).some(r=>r.textContent.includes(${JSON.stringify(booking.reference)}))`,
    180000,
  );
  await ownerPage.evaluate(
    `Array.from(document.querySelectorAll('tr')).find(r=>r.textContent.includes(${JSON.stringify(booking.reference)})).querySelector('button').click()`,
  );
  await ownerPage.click("View details");
  await ownerPage.waitFor(
    `document.body.innerText.includes(${JSON.stringify(booking.reference)}) && Array.from(document.querySelectorAll('h1')).some(h=>h.textContent==='View booking') && Array.from(document.querySelectorAll('button')).some(b=>/^(Complete Booking|Complete package session|Cancel No-show)$/.test(b.textContent.trim()))`,
    120000,
  );
}
async function calendarRead(
  booking: { reference: string; schedule: { startAt: Date; timezone: string } },
  serviceName: string,
  artifact: string,
) {
  await ownerPage.goto(`${h.uiOrigin}/business-dashboard?section=calendar`);
  await ownerPage.waitFor(
    "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('Weekly'))",
    180000,
  );
  await ownerPage.click("Weekly");
  await ownerPage.click("Monthly");
  const dateNumber = new Intl.DateTimeFormat("en-US", {
    timeZone: booking.schedule.timezone,
    day: "numeric",
  }).format(booking.schedule.startAt);
  await ownerPage.waitFor(
    `Array.from(document.querySelectorAll('span')).filter(e=>e.textContent.trim()===${JSON.stringify(dateNumber)}).length > 0`,
  );
  await ownerPage.evaluate(
    `Array.from(document.querySelectorAll('span')).filter(e=>e.textContent.trim()===${JSON.stringify(dateNumber)}).at(-1).parentElement.parentElement.click()`,
  );
  await ownerPage.waitFor(
    "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('Today'))",
  );
  await ownerPage.click("Today");
  await ownerPage.click("Weekly");
  await ownerPage.waitFor(
    `Array.from(document.querySelectorAll('div')).some(d=>d.textContent===${JSON.stringify(serviceName)})`,
    120000,
  );
  await ownerPage.evaluate(
    `Array.from(document.querySelectorAll('div')).find(d=>d.textContent===${JSON.stringify(serviceName)}).parentElement.click()`,
  );
  await ownerPage.click("View Booking");
  await ownerPage.waitFor(
    `document.body.innerText.includes(${JSON.stringify(booking.reference)})`,
    120000,
  );
  await ownerPage.screenshot(artifact);
}
async function completeUi(
  b: Awaited<ReturnType<typeof lastBooking>>,
  mode: "FULL" | "PARTIAL" | "NOT_PAID",
) {
  await openOwnerBooking(b);
  await ownerPage.evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>/^(Complete Booking|Complete package session)$/.test(b.textContent.trim())).click()",
  );
  await ownerPage.waitFor("document.body.innerText.includes('Did the customer pay')");
  if (mode !== "FULL") {
    await ownerPage.evaluate(
      "Array.from(document.querySelectorAll('span')).find(e=>e.textContent.includes('Yes - customer')).parentElement.click()",
    );
    await ownerPage.click(mode === "PARTIAL" ? "other amount" : "No - customer");
    if (mode === "PARTIAL") await ownerPage.fill("input[type=number]", "10.00");
  }
  await ownerPage.screenshot(`B4-${mode}-${b._id}-before.png`);
  await ownerPage.evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Yes').click()",
  );
  await expect
    .poll(async () => (await BookingModel.findById(b._id))?.status, { timeout: 20000 })
    .toBe("COMPLETED");
  const updated = await BookingModel.findById(b._id).orFail();
  expect(updated.completionPayment?.amountCents ?? 0).toBe(
    mode === "FULL" ? b.financials.balanceDueCents : mode === "PARTIAL" ? 1000 : 0,
  );
  await crossRole(String(b._id));
  await ownerPage.screenshot(`B4-${mode}-${b._id}.png`);
}
async function redeemUi(extra = false, drop = false, travel = false) {
  await page.goto(`${h.uiOrigin}/customer/packages/${packageId}`);
  await page.waitFor(
    "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('Schedule next session')&&!b.disabled)",
    120000,
  );
  await page.click("Schedule next session");
  await page.waitFor("document.body.innerText.includes('Select Add-ons')");
  if (extra) {
    await page.waitFor("document.querySelector('[aria-label=\"Add Synthetic scalp treatment\"]')");
    await page.evaluate(
      "document.querySelector('[aria-label=\"Add Synthetic scalp treatment\"]').click()",
    );
  }
  await page.click("Continue");
  if (travel) await travelUi(true);
  await page.waitFor("document.body.innerText.includes('Select Professional')");
  await page.evaluate(
    "Array.from(document.querySelectorAll('h4')).find(e=>e.textContent==='No Preference').parentElement.parentElement.parentElement.click()",
  );
  await page.click("Continue");
  // Travel appointments consume setup/transfer time. Use a mid-day slot rather than one near
  // closing, where the UI's broad slot list can exceed the travel-buffer rules.
  await chooseTime(page, !travel, false, travel ? "12:00 PM" : undefined, travel);
  await page.waitFor(
    "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Review'&&!b.disabled)",
  );
  await page.click("Review");
  await page.waitFor(
    "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Confirm session'&&!b.disabled)",
  );
  await page.screenshot(extra ? "C4-redemption-preview.png" : "C3-redemption-preview.png");
  if (drop) await page.dropNextResponse(`/packages/${packageId}/sessions`);
  await page.click("Confirm session");
}
async function chooseTime(
  p: P4kPage,
  last = false,
  lastSlot = false,
  slotLabel?: string,
  nextMonth = false,
) {
  if (nextMonth) {
    await p.waitFor("document.querySelector('[aria-label=\"Show next month\"]')");
    await p.evaluate("document.querySelector('[aria-label=\"Show next month\"]').click()");
    await p.waitFor("document.body.innerText.includes('December 2026')");
  }
  await p.waitFor(
    "Array.from(document.querySelectorAll('button')).some(b=>!b.disabled && /^\\d+(?:\\s*TODAY)?$/.test(b.textContent.trim()))",
    120000,
  );
  await p.evaluate(
    `Array.from(document.querySelectorAll('button')).filter(b=>!b.disabled && /^\\d+(?:\\s*TODAY)?$/.test(b.textContent.trim())).at(${last ? -1 : 0}).click()`,
  );
  await p.waitFor(
    "Array.from(document.querySelectorAll('button')).some(b=>!b.disabled && /\\d+:\\d+/.test(b.textContent))",
  );
  await p.evaluate(
    slotLabel
      ? `Array.from(document.querySelectorAll('button')).find(b=>!b.disabled && b.textContent.trim().startsWith(${JSON.stringify(slotLabel)})).click()`
      : `Array.from(document.querySelectorAll('button')).filter(b=>!b.disabled && /\\d+:\\d+/.test(b.textContent)).at(${lastSlot ? -1 : 0}).click()`,
  );
}
async function login(email: string, target: string) {
  await page.clearStorage();
  await page.goto(`${h.uiOrigin}/customer/bookings`);
  await page.waitFor("location.pathname === '/select-role'", 180000);
  await page.waitFor(
    "Array.from(document.querySelectorAll('button')).some(b=>Object.keys(b).some(k=>k.startsWith('__reactProps') && b[k]?.onClick))",
  );
  await page.click("Continue");
  await page.waitFor(
    "location.pathname === '/customer' && document.querySelector('input[type=email]')",
    180000,
  );
  await page.waitFor(
    "(() => { const el=document.querySelector('input[type=email]');return Object.keys(el).some(k=>k.startsWith('__reactProps')&&el[k]?.onChange); })()",
  );
  await page.fill("input[type=email]", email);
  await page.waitFor(
    `(() => { const el=document.querySelector('input[type=email]');return Object.keys(el).some(k=>k.startsWith('__reactProps')&&el[k]?.value===${JSON.stringify(email)}); })()`,
  );
  await page.evaluate("document.querySelector('form').requestSubmit()");
  await page.waitFor("document.querySelector('input[type=password]')", 180000);
  await page.waitFor(
    "(() => { const el=document.querySelector('input[type=password]');return Object.keys(el).some(k=>k.startsWith('__reactProps')&&el[k]?.onChange); })()",
  );
  await page.fill("input[type=password]", h.seed.password);
  await page.waitFor(
    `(() => { const el=document.querySelector('input[type=password]');return Object.keys(el).some(k=>k.startsWith('__reactProps')&&el[k]?.value===${JSON.stringify(h.seed.password)}); })()`,
  );
  await page.evaluate("document.querySelector('form').requestSubmit()");
  await page.waitFor("location.pathname === '/customer/bookings'", 180000);
  await page.goto(target);
}
async function travelUi(modal = false) {
  const root = modal ? '[role="dialog"]' : null;
  await page.waitFor(
    `${root ? `document.querySelector(${JSON.stringify(root)})?.` : "document."}querySelector('select')`,
  );
  const selectedAddress = await page.evaluate<{ values: string[]; options: string[][] }>(
    `(async() => { const root=${root ? `document.querySelector(${JSON.stringify(root)})` : "document"};const selects=Array.from(root.querySelectorAll('select'));for(const [i,label] of [[0,'Larnaca'],[1,'House']]){const el=selects[i];const option=Array.from(el.options).find(o=>o.textContent.trim()===label);if(!option)throw Error('Missing travel option '+label+': '+JSON.stringify(Array.from(el.options).map(o=>({text:o.textContent,value:o.value}))));Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,option.value);el.dispatchEvent(new Event('change',{bubbles:true}));const key=Object.keys(el).find(k=>k.startsWith('__reactProps'));const onChange=key&&el[key].onChange;if(typeof onChange==='function')onChange({target:{value:option.value}});}await new Promise(resolve=>requestAnimationFrame(resolve));return {values:selects.map(el=>el.value),options:selects.map(el=>Array.from(el.options).map(o=>o.value))}; })()`,
  );
  expect(selectedAddress.values, JSON.stringify(selectedAddress.options)).toEqual([
    "Larnaca",
    "House",
  ]);
  await page.fill('input[placeholder="e.g. Mackenzie, Finikoudes"]', "Center");
  await page.fill('input[placeholder="e.g. Emrou"]', "Synthetic");
  await page.fill('input[placeholder="e.g. 14"]', "7");
  await page.waitFor(
    `${root ? `Array.from(document.querySelector(${JSON.stringify(root)}).querySelectorAll('button'))` : "Array.from(document.querySelectorAll('button'))"}.some(b=>b.textContent.includes('Continue')&&!b.disabled)`,
  );
  await page.click("Continue", root ?? undefined);
}
async function checkout(
  serviceId: string,
  options: {
    venueId?: string;
    quantity?: number;
    confirm?: boolean;
    extra?: boolean;
    travel?: boolean;
    promo?: boolean;
    timeLabel?: string;
  } = {},
) {
  await page.goto(`${h.uiOrigin}/venue?id=${options.venueId ?? h.seed.venue.id}`);
  await page.waitFor("document.querySelector('[aria-label=\"Service filters\"]')", 180000);
  await page.waitFor(
    "(() => {const b=document.querySelector('[aria-label=\"Service filters\"] button');return b && Object.keys(b).some(k=>k.startsWith('__reactProps')&&b[k]?.onClick);})()",
  );
  await page.click("All", '[aria-label="Service filters"]');
  const allFilterSelected = await page.evaluate<boolean>(
    "document.querySelector('[aria-label=\\\"Service filters\\\"] button[aria-pressed=true]')?.textContent?.trim()==='All'",
  );
  if (!allFilterSelected) {
    await page.evaluate(
      `(() => { const root=document.querySelector('[aria-label="Service filters"]');const button=Array.from(root.querySelectorAll('button')).find(b=>b.textContent.trim()==='All');const key=Object.keys(button).find(k=>k.startsWith('__reactProps'));if(!key||typeof button[key].onClick!=='function')throw Error('All filter React action is unavailable');button[key].onClick(); })()`,
    );
  }
  await page.waitFor(
    "document.querySelector('[aria-label=\"Service filters\"] button[aria-pressed=true]')?.textContent==='All'",
  );
  await page.waitFor(
    `document.querySelector('[data-offering-id="${serviceId}"] button[aria-label^="Book "]')`,
  );
  for (let i = 1; i < (options.quantity ?? 1); i++) {
    await page.evaluate(
      `Array.from(document.querySelector('[data-offering-id="${serviceId}"]').querySelectorAll('button')).find(b=>b.textContent.trim()==='+').click()`,
    );
  }
  await page.evaluate(
    `document.querySelector('[data-offering-id="${serviceId}"] button[aria-label^="Book "]').click()`,
  );
  await page.waitFor("document.body.innerText.includes('Add-ons')");
  if (options.extra) {
    await page.waitFor("document.querySelector('[aria-label=\"Add Synthetic scalp treatment\"]')");
    await page.evaluate(
      "document.querySelector('[aria-label=\"Add Synthetic scalp treatment\"]').click()",
    );
  }
  await page.click("Continue →");
  if (options.travel) {
    await page.waitFor("document.querySelector('select')");
    await page.evaluate(
      `(() => { const selects=Array.from(document.querySelectorAll('select'));for(const [i,value] of [[0,'Larnaca'],[1,'House']]){const el=selects[i];Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('change',{bubbles:true}));} })()`,
    );
    await page.fill('input[placeholder="e.g. Mackenzie, Finikoudes"]', "Center");
    await page.fill('input[placeholder="e.g. Emrou"]', "Synthetic");
    await page.fill('input[placeholder="e.g. 14"]', "7");
    await page.waitFor(
      "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('Continue')&&!b.disabled)",
    );
    await page.click("Continue →");
  }
  await page.waitFor("document.body.innerText.includes('Select Professional')");
  await page.evaluate(
    "Array.from(document.querySelectorAll('h4')).find(e=>e.textContent==='No Preference').parentElement.parentElement.parentElement.click()",
  );
  await page.click("Continue →");
  await page.waitFor(
    "Array.from(document.querySelectorAll('button')).some(b=>!b.disabled && /^\\d+(?:\\s*TODAY)?$/.test(b.textContent.trim()))",
    120000,
  );
  await page.evaluate(
    "Array.from(document.querySelectorAll('button')).filter(b=>!b.disabled && /^\\d+(?:\\s*TODAY)?$/.test(b.textContent.trim())).at(-1).click()",
  );
  await page.waitFor(
    "Array.from(document.querySelectorAll('button')).some(b=>!b.disabled && /\\d+:\\d+/.test(b.textContent))",
  );
  await page.evaluate(
    options.timeLabel
      ? `Array.from(document.querySelectorAll('button')).find(b=>!b.disabled && b.textContent.trim().startsWith(${JSON.stringify(options.timeLabel)})).click()`
      : "Array.from(document.querySelectorAll('button')).find(b=>!b.disabled && /\\d+:\\d+/.test(b.textContent)).click()",
  );
  await page.click("Continue →");
  await page.waitFor(
    "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Confirm' && !b.disabled)",
    120000,
  );
  if (options.promo) {
    await page.fill('input[placeholder="Promo code"]', "BCF06TEN");
    await page.click("Apply");
    await page.waitFor("document.body.innerText.includes('Remove')");
    await page.click("Remove");
    await page.fill('input[placeholder="Promo code"]', "BCF06TEN");
    await page.click("Apply");
    await page.waitFor("document.body.innerText.includes('Remove')");
    await page.waitFor(
      "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Confirm'&&!b.disabled)",
    );
  }
  await page.screenshot("checkout-preview.png");
  if (options.confirm === false) return;
  await page.click("Confirm");
  await page.waitFor("document.body.innerText.includes('Booking Confirmed!')", 120000);
}

describe.skipIf(!artifacts || !clientRoot)("BC-F06 real Next booking integration", () => {
  beforeAll(async () => {
    await mkdir(artifacts, { recursive: true });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(initialClock));
    h = await startP4kHarness();
    const template = await ServiceModel.findById(h.seed.venue.services.hair).lean().orFail();
    const { _id: _ignored, fixedPricing: _fixed, ...base } = template;
    const hourly = await ServiceModel.create({
      ...base,
      name: "Hourly Studio",
      pricingMode: "HOURLY",
      hourlyPricing: { ratePerHourCents: 4000, minHours: 1, maxHours: 4, bufferAfterMin: 10 },
    });
    hourlyId = String(hourly._id);
    const legacy = await ServiceModel.create({
      ...base,
      name: "Legacy Hair Three",
      pricingMode: undefined,
      isPackageDeal: true,
      packagePricing: {
        bundlePriceCents: 18000,
        sessionsInPackage: 3,
        durationMin: 60,
        bookingIntervalMin: 15,
        bufferAfterMin: 10,
      },
    });
    legacyId = String(legacy._id);
    await AddonServiceAssignmentModel.create({
      businessId: h.seed.venue.id,
      serviceId: legacy._id,
      addonId: h.seed.venue.addonId,
    });
    next = await startP4kClient({ clientRoot, apiOrigin: h.apiOrigin, uiOrigin: h.uiOrigin });
    await writeFile(
      join(artifacts, "environment.json"),
      JSON.stringify(
        {
          database: h.database,
          apiOrigin: h.apiOrigin,
          uiOrigin: h.uiOrigin,
          provider: "FakePaymentGateway; FakeTaxGateway",
          firstClassAuthority: "SHIPPED DENIED",
        },
        null,
        2,
      ),
    );
    for (const route of [
      "/select-role",
      "/customer",
      "/customer/password",
      "/customer/bookings",
      `/venue?id=${h.seed.venue.id}`,
    ]) {
      const r = await fetch(`${h.uiOrigin}${route}`, { signal: AbortSignal.timeout(120000) });
      expect(r.ok, route).toBe(true);
      await r.text();
    }
    page = await openP4kBrowser({
      artifacts,
      authenticate: (clientSecret, result) => simulateAuthentication({ clientSecret }, result),
    });
    await page.setClock(initialClock);
    ownerPage = await openP4kBrowser({
      artifacts,
      authenticate: (clientSecret, result) => simulateAuthentication({ clientSecret }, result),
    });
    await ownerPage.setClock(initialClock);
    if (process.env["BOOKLY_BCF06_API_SESSION"] === "1")
      await session(page, h.seed.accounts.customer, "customer", "/customer/bookings");
  }, 600000);
  afterAll(async () => {
    await Promise.all([page?.close(), ownerPage?.close()]);
    await next?.stop();
    await h?.stop();
    vi.useRealTimers();
  }, 60000);
  it(
    "A1 FIRST fixed checkout commits booking and history",
    () =>
      journey("A1", async () => {
        await login(h.seed.accounts.customer, `${h.uiOrigin}/venue?id=${h.seed.venue.id}`);
        await session(page, h.seed.accounts.customer, "customer", `/venue?id=${h.seed.venue.id}`);
        const catalog = await fetch(`${h.apiOrigin}/api/v1/catalog/businesses/${h.seed.venue.id}`);
        await writeFile(join(artifacts, "A1-catalog.json"), await catalog.text());
        await checkout(String(h.seed.venue.services.hair));
        const booking = await BookingModel.findOne({
          businessId: h.seed.venue.id,
          "customer.customerUserId": h.seed.customer,
        }).orFail();
        await writeFile(
          join(artifacts, "A1-booking.json"),
          JSON.stringify(booking.toObject(), null, 2),
        );
        firstId = String(booking._id);
        expect(booking.financialContract?.classification).toBe("FIRST");
        expect(booking.financialContract?.onlineChargeCents).toBe(1800);
        expect(await BookingModel.countDocuments({ businessId: h.seed.venue.id })).toBe(1);
        expect(harnessGateway.createdPaymentIntentIds()).toHaveLength(1);
        expect(
          await BookingSlotReservationModel.countDocuments({
            "intervals.reservationId": booking.serviceLines[0]!.reservationId,
          }),
        ).toBeGreaterThan(0);
        expect(await PaymentAttemptModel.countDocuments()).toBe(1);
        expect(
          await BookingFinancialTransactionModel.countDocuments({ bookingId: booking._id }),
        ).toBeGreaterThan(0);
        expect(await page.text()).toContain(booking.reference);
        await page.screenshot("A1-confirmed.png");
        await writeFile(
          join(artifacts, "A1-booking.json"),
          JSON.stringify(booking.toObject(), null, 2),
        );
        await page.goto(`${h.uiOrigin}/customer/bookings`);
        await page.waitFor(
          `document.body.innerText.includes(${JSON.stringify(booking.reference)})`,
          120000,
        );
        await page.reload();
        await page.waitFor(
          `document.body.innerText.includes(${JSON.stringify(booking.reference)})`,
          120000,
        );
        await page.screenshot("A1-history.png");
        await crossRole(firstId);
      }),
    300000,
  );
  it(
    "A2 RETURNING fixed has zero upfront and no new provider operation",
    () =>
      journey("A2", async () => {
        const before = harnessGateway.createdPaymentIntentIds().length;
        await checkout(String(h.seed.venue.services.facial));
        const b = await lastBooking();
        returningId = String(b._id);
        expect(b.financialContract?.classification).toBe("RETURNING");
        expect(b.financialContract?.onlineChargeCents).toBe(0);
        expect(b.financials.balanceDueCents).toBe(b.financials.totalCents);
        expect(harnessGateway.createdPaymentIntentIds()).toHaveLength(before);
        expect(await PaymentAttemptModel.countDocuments({ bookingId: b._id })).toBe(0);
        await crossRole(returningId);
        await page.screenshot("A2-confirmed.png");
      }),
    240000,
  );
  it(
    "A3 hourly preserves two hours and a 130 minute reservation",
    () =>
      journey("A3", async () => {
        await checkout(hourlyId, { quantity: 2 });
        const b = await lastBooking();
        expect(b.serviceLines[0]!.pricingInput.hours).toBe(2);
        expect(b.financials.totalCents).toBe(8000);
        expect(b.schedule.endAt.getTime() - b.schedule.startAt.getTime()).toBe(130 * 60000);
        const r = await BookingSlotReservationModel.findOne({
          "intervals.reservationId": b.serviceLines[0]!.reservationId,
        }).orFail();
        const interval = r.intervals.find((i) =>
          i.reservationId.equals(b.serviceLines[0]!.reservationId),
        )!;
        expect(interval.startAt).toEqual(b.schedule.startAt);
        expect(interval.endAt).toEqual(b.schedule.endAt);
        await crossRole(String(b._id));
        await page.reload();
        await page.goto(`${h.uiOrigin}/customer/bookings`);
        await page.waitFor(`document.body.innerText.includes(${JSON.stringify(b.reference)})`);
        await page.screenshot("A3-history.png");
      }),
    240000,
  );
  it(
    "A4 group UI quantity and competing final-seat admission",
    () =>
      journey("A4", async () => {
        await checkout(String(h.seed.venue.services.yoga), { quantity: 2 });
        const b = await lastBooking();
        expect(b.serviceLines[0]!.pricingInput.personCount).toBe(2);
        expect(b.financials.totalCents).toBe(6000);
        const line = b.serviceLines[0]!;
        const auth = await token(h.seed.accounts.customer);
        const input = {
          startAt: b.schedule.startAt.toISOString(),
          serviceLines: [
            {
              serviceId: String(line.serviceId),
              staffMembershipId: String(line.responsibleStaffMembershipId),
              pricingInput: { personCount: 1 },
              addonIds: [],
            },
          ],
        };
        const contenders = await Promise.all([
          post(`/businesses/${b.businessId}/bookings/finalize`, auth, {
            ...input,
            idempotencyKey: randomUUID(),
          }),
          post(`/businesses/${b.businessId}/bookings/finalize`, auth, {
            ...input,
            idempotencyKey: randomUUID(),
          }),
        ]);
        expect(contenders.filter((r) => [200, 201].includes(r.status))).toHaveLength(1);
        expect(contenders.filter((r) => [409, 422].includes(r.status))).toHaveLength(1);
        const r = await BookingSlotReservationModel.findOne({
          "intervals.reservationId": line.reservationId,
        }).orFail();
        expect(
          r.intervals.find((i) => i.reservationId.equals(line.reservationId))!.capacityUsed,
        ).toBe(3);
        await crossRole(String(b._id));
        await page.screenshot("A4-confirmed.png");
      }),
    240000,
  );
  it(
    "B1 Customer reschedule moves the reservation and preserves financial terms",
    () =>
      journey("B1", async () => {
        const old = await BookingModel.findById(firstId).orFail();
        await page.goto(`${h.uiOrigin}/customer/bookings`);
        await page.waitFor("document.body.innerText.includes('Reschedule')");
        await cardAction(page, old.reference, "Reschedule");
        await page.waitFor("document.body.innerText.includes('Reschedule booking')");
        await chooseTime(page);
        await page.waitFor(
          "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('Save')&&!b.disabled)",
        );
        await page.click("Save");
        await page.waitFor("!document.body.innerText.includes('Reschedule booking')");
        const moved = await BookingModel.findById(firstId).orFail();
        expect(moved.schedule.startAt).not.toEqual(old.schedule.startAt);
        expect(JSON.parse(JSON.stringify(moved.financialContract))).toEqual(
          JSON.parse(JSON.stringify(old.financialContract)),
        );
        const previous = await BookingSlotReservationClaimModel.findOne({
          reservationId: old.serviceLines[0]!.reservationId,
        }).orFail();
        expect(previous.effect?.state).toBe("RELEASED");
        await crossRole(firstId);
        await page.screenshot("B1-history.png");
      }),
    240000,
  );
  it(
    "C1 Legacy purchase creates one progress and first appointment",
    () =>
      journey("C1", async () => {
        await checkout(legacyId);
        const b = await lastBooking();
        const progress = await PackageProgressModel.findOne({
          customerUserId: h.seed.customer,
          serviceId: legacyId,
        }).orFail();
        packageId = String(progress._id);
        expect(progress.totalSessions).toBe(3);
        expect(progress.remainingSessions).toBe(2);
        expect(await PackageProgressModel.countDocuments({ serviceId: legacyId })).toBe(1);
        expect(b.serviceLines[0]!.pricingInput.packageProgressId?.toString()).toBe(packageId);
        await page.goto(`${h.uiOrigin}/customer/bookings?view=packages`);
        await page.waitFor("document.body.innerText.includes('Legacy Hair Three')", 120000);
        await page.screenshot("C1-my-packages.png");
        await crossRole(String(b._id));
      }),
    240000,
  );

  it(
    "B2 Owner reschedule through booking detail and live authority",
    () =>
      journey("B2", async () => {
        await session(
          ownerPage,
          h.seed.accounts.owner,
          "professional",
          "/business-dashboard?section=all-bookings",
        );
        const b = await BookingModel.findById(returningId).orFail();
        await calendarRead(b, "Facial", "B2-calendar-read.png");
        await openOwnerBooking(b);
        await ownerPage.click("Reschedule");
        await ownerPage.waitFor("document.body.innerText.includes('Reschedule booking')");
        await chooseTime(ownerPage);
        await ownerPage.waitFor(
          "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('Save')&&!b.disabled)",
        );
        await ownerPage.click("Save");
        await expect
          .poll(async () => String((await BookingModel.findById(b._id))?.schedule.startAt), {
            timeout: 20000,
          })
          .not.toBe(String(b.schedule.startAt));
        const auth = await token(h.seed.accounts.staff, "professional");
        expect(
          (
            await post(`/businesses/${b.businessId}/bookings/${b._id}/reschedule`, auth, {
              startAt: b.schedule.startAt.toISOString(),
            })
          ).status,
        ).toBe(403);
        await crossRole(String(b._id));
        await ownerPage.screenshot("B2-owner-rescheduled.png");
      }),
    300000,
  );
  it(
    "B3 late Customer cancellation releases capacity once and updates both roles",
    () =>
      journey("B3", async () => {
        const b = await BookingModel.findById(firstId).orFail();
        const frozen = JSON.stringify(b.financialContract);
        await page.goto(`${h.uiOrigin}/customer/bookings`);
        await page.waitFor(`document.body.innerText.includes(${JSON.stringify(b.reference)})`);
        await cardAction(page, b.reference, "Cancel");
        await page.waitFor("document.body.innerText.includes('Cancel your booking?')");
        await page.click("Yes, cancel");
        await page.waitFor("document.body.innerText.includes('Cancellation Confirmed')");
        const updated = await BookingModel.findById(b._id).orFail();
        expect(updated.status).toBe("LATE_CANCELLATION");
        expect(JSON.stringify(updated.financialContract)).toBe(frozen);
        const claim = await BookingSlotReservationClaimModel.findOne({
          reservationId: b.serviceLines[0]!.reservationId,
        }).orFail();
        expect(claim.effect?.state).toBe("RELEASED");
        const before = await BookingFinancialTransactionModel.countDocuments({ bookingId: b._id });
        await post(`/me/bookings/${b._id}/cancel`, await token(h.seed.accounts.customer));
        expect(await BookingFinancialTransactionModel.countDocuments({ bookingId: b._id })).toBe(
          before,
        );
        await crossRole(String(b._id));
        await page.screenshot("B3-cancelled.png");
      }),
    240000,
  );
  it(
    "B4 full partial and unpaid venue settlement never creates an online charge",
    () =>
      journey("B4", async () => {
        await session(
          ownerPage,
          h.seed.accounts.owner,
          "professional",
          "/business-dashboard?section=all-bookings",
        );
        const before = harnessGateway.createdPaymentIntentIds().length;
        for (const mode of ["FULL", "PARTIAL", "NOT_PAID"] as const) {
          await page.clearStorage();
          await session(page, h.seed.accounts.customer, "customer", "/customer/bookings");
          await checkout(String(h.seed.venue.services.hair));
          const b = await lastBooking();
          await completeUi(b, mode);
          const ledgerBefore = await BookingFinancialTransactionModel.countDocuments({
            bookingId: b._id,
            type: "PAYMENT",
          });
          const retry = await post(
            `/businesses/${b.businessId}/bookings/${b._id}/complete`,
            await token(h.seed.accounts.owner, "professional"),
            {
              venuePayment: {
                settlement: mode,
                ...(mode === "PARTIAL" ? { amountCents: 1000 } : {}),
              },
            },
          );
          expect([409, 422]).toContain(retry.status);
          expect(
            await BookingFinancialTransactionModel.countDocuments({
              bookingId: b._id,
              type: "PAYMENT",
            }),
          ).toBe(ledgerBefore);
        }
        expect(harnessGateway.createdPaymentIntentIds()).toHaveLength(before);
      }),
    480000,
  );
  it(
    "C2 original settlement gates redemption and C3 free redemption commits",
    () =>
      journey("C2-C3", async () => {
        await session(
          ownerPage,
          h.seed.accounts.owner,
          "professional",
          "/business-dashboard?section=all-bookings",
        );
        const progress = await PackageProgressModel.findById(packageId).orFail();
        const origin = await BookingModel.findById(progress.originBookingId).orFail();
        const rejected = await post(
          `/businesses/${h.seed.venue.id}/bookings/packages/${packageId}/sessions`,
          await token(h.seed.accounts.customer),
          {
            idempotencyKey: randomUUID(),
            staffMembershipId: String(origin.serviceLines[0]!.responsibleStaffMembershipId),
            startAt: origin.schedule.startAt.toISOString(),
            addonIds: [],
          },
        );
        expect([409, 422]).toContain(rejected.status);
        expect(JSON.stringify(rejected.body)).toMatch(/SETTLE|BALANCE|UNSETTLED/i);
        await calendarRead(origin, "Legacy Hair Three", "C2-calendar-read.png");
        await completeUi(origin, "FULL");
        const before = harnessGateway.createdPaymentIntentIds().length;
        await redeemUi();
        await expect
          .poll(async () => (await PackageProgressModel.findById(packageId))?.remainingSessions, {
            timeout: 30000,
          })
          .toBe(progress.remainingSessions - 1);
        const b = await lastBooking();
        expect(b.financials.totalCents).toBe(0);
        expect(b.serviceLines[0]!.pricingInput.packageProgressId?.toString()).toBe(packageId);
        expect(harnessGateway.createdPaymentIntentIds()).toHaveLength(before);
        await crossRole(String(b._id));
        await page.reload();
        await page.waitFor("document.body.innerText.includes('Legacy Hair Three')");
        await page.screenshot("C3-progress.png");
      }),
    480000,
  );
  it(
    "C4 extras and C5 lost response recover original consumed entitlement",
    () =>
      journey("C4-C5", async () => {
        const progress = await PackageProgressModel.findById(packageId).orFail();
        await redeemUi(true, true);
        await expect
          .poll(async () => (await PackageProgressModel.findById(packageId))?.remainingSessions, {
            timeout: 30000,
          })
          .toBe(progress.remainingSessions - 1);
        const progressAfter = await PackageProgressModel.findById(packageId).orFail();
        const finalSession = [...progressAfter.sessions].sort(
          (left, right) => right.sessionIndex - left.sessionIndex,
        )[0]!;
        const b = await BookingModel.findById(finalSession.bookingId).orFail();
        await writeFile(
          join(artifacts, "C4-C5-committed-session.json"),
          JSON.stringify(
            {
              progress: {
                remainingSessions: progressAfter.remainingSessions,
                sessions: progressAfter.sessions,
              },
              booking: {
                id: b._id,
                reference: b.reference,
                schedule: b.schedule,
                servicesSubtotalCents: b.financials.servicesSubtotalCents,
                addonsSubtotalCents: b.financials.addonsSubtotalCents,
                travelFeeCents: b.financials.travelFeeCents,
                totalCents: b.financials.totalCents,
              },
            },
            null,
            2,
          ),
        );
        expect(b.financials.servicesSubtotalCents).toBe(0);
        expect(b.financials.addonsSubtotalCents).toBe(500);
        await page.reload();
        await page.waitFor("document.body.innerText.includes('original')", 120000);
        await page.waitFor(
          "document.body.innerText.includes('confirmed') || document.body.innerText.includes('committed')",
          120000,
        );
        expect((await PackageProgressModel.findById(packageId))?.remainingSessions).toBe(0);
        await crossRole(String(b._id));
        await page.screenshot("C5-recovered.png");
      }),
    300000,
  );
  it(
    "C6 eligible redeemed cancellation restores one credit and C7 ownership rejects",
    () =>
      journey("C6-C7", async () => {
        const b = await lastBooking();
        const before = (await PackageProgressModel.findById(packageId))!.remainingSessions;
        await page.goto(`${h.uiOrigin}/customer/bookings`);
        await page.waitFor(`document.body.innerText.includes(${JSON.stringify(b.reference)})`);
        await cardAction(page, b.reference, "Cancel");
        await page.click("Yes, cancel");
        await page.waitFor("document.body.innerText.includes('Cancellation Confirmed')");
        expect((await PackageProgressModel.findById(packageId))?.remainingSessions).toBe(
          before + 1,
        );
        await post(`/me/bookings/${b._id}/cancel`, await token(h.seed.accounts.customer));
        expect((await PackageProgressModel.findById(packageId))?.remainingSessions).toBe(
          before + 1,
        );
        expect(
          (await api(`/me/packages/${packageId}`, await token(h.seed.accounts.otherCustomer)))
            .status,
        ).toBe(404);
        await page.goto(`${h.uiOrigin}/customer/packages/${packageId}`);
        await page.waitFor("document.body.innerText.includes('Legacy Hair Three')");
        await page.screenshot("C6-restored.png");
        await crossRole(String(b._id));
      }),
    240000,
  );

  it(
    "A5 FIRST travel add-on promo apply/remove uses server-owned deposit basis",
    () =>
      journey("A5", async () => {
        await PromoCodeModel.create({
          code: "BCF06TEN",
          normalizedCode: "BCF06TEN",
          type: "PERCENTAGE",
          value: 10,
          scope: "SELECTED_BUSINESSES",
          businessIds: [h.seed.travel.id],
          expiresAt: new Date(Date.now() + 86400000 * 60),
          status: "ACTIVE",
          createdByUserId: h.seed.venue.ownerUserId,
        });
        await checkout(String(h.seed.travel.services.hair), {
          venueId: String(h.seed.travel.id),
          extra: true,
          travel: true,
          promo: true,
        });
        const b = await lastBooking(h.seed.travel.id);
        expect(b.financials.travelFeeCents).toBe(300);
        expect(b.financials.addonsSubtotalCents).toBe(500);
        expect(b.financialContract?.classification).toBe("FIRST");
        expect(b.financialContract?.eligibleBasisCents).toBe(8550);
        expect(b.financialContract?.onlineChargeCents).toBe(1710);
        expect(b.financials.totalCents).toBe(8850);
        expect(b.fulfilment.travelAddress?.city).toBe("Larnaca");
        const attempt = await PaymentAttemptModel.findOne({ bookingId: b._id }).orFail();
        expect(attempt.expectedAmountCents).toBe(1710);
        expect(attempt.providerStatus).toBe("SUCCEEDED");
        expect(attempt.persistenceStatus).toBe("COMPLETED");
        const provider = await harnessGateway.retrievePaymentIntent(
          attempt.providerPaymentIntentId!,
        );
        expect(provider.amountCents).toBe(1710);
        await writeFile(
          join(artifacts, "A5-financial.json"),
          JSON.stringify(
            {
              booking: b,
              provider: { amountCents: provider.amountCents, status: provider.status },
              attempt: {
                providerStatus: attempt.providerStatus,
                persistenceStatus: attempt.persistenceStatus,
                expectedAmountCents: attempt.expectedAmountCents,
              },
            },
            null,
            2,
          ),
        );
        await page.screenshot("A5-confirmed.png");
      }),
    240000,
  );
  it(
    "A6 fake decline and action-required retain truthful original outcomes",
    () =>
      journey("A6-decline-3ds", async () => {
        for (const outcome of ["failed", "requires_action"] as const) {
          const v = await seedP4kPaymentVenue();
          const before = harnessGateway.createdPaymentIntentIds().length;
          await checkout(String(v.services.hair), { venueId: String(v.id), confirm: false });
          harnessGateway.queueNextChargeOutcome(outcome);
          await page.set3ds("succeeded");
          await page.click("Confirm");
          if (outcome === "failed") {
            await page.waitFor(
              "document.body.innerText.toLowerCase().includes('failed') || document.body.innerText.toLowerCase().includes('declined')",
            );
            expect(await BookingModel.countDocuments({ businessId: v.id })).toBe(0);
            expect(await BookingSlotReservationModel.countDocuments({ businessId: v.id })).toBe(0);
            expect(await page.text()).not.toContain("Booking Confirmed!");
          } else {
            await page.waitFor("document.body.innerText.includes('Booking Confirmed!')", 120000);
            const b = await lastBooking(v.id);
            expect(
              await PaymentAttemptModel.countDocuments({
                bookingId: b._id,
                providerStatus: "SUCCEEDED",
                persistenceStatus: "COMPLETED",
              }),
            ).toBe(1);
          }
          const attempt = await PaymentAttemptModel.findOne({ businessId: v.id }).orFail();
          if (outcome === "failed") {
            expect(["NOT_CREATED", "FAILED"]).toContain(attempt.providerStatus);
          } else {
            expect(attempt.providerStatus).toBe("SUCCEEDED");
          }
          if (outcome === "requires_action") {
            expect(harnessGateway.createdPaymentIntentIds()).toHaveLength(before + 1);
          }
          await page.screenshot(`A6-${outcome}.png`);
        }
      }),
    480000,
  );
  it(
    "A6 lost POST response refresh duplicate confirm expiry and reauthentication",
    () =>
      journey("A6-lost-response", async () => {
        const v = await seedP4kPaymentVenue();
        const before = harnessGateway.createdPaymentIntentIds().length;
        await checkout(String(v.services.hair), { venueId: String(v.id), confirm: false });
        await page.dropNextResponse("/bookings/finalize");
        await page.click("Confirm");
        await expect
          .poll(() => BookingModel.countDocuments({ businessId: v.id }), { timeout: 30000 })
          .toBe(1);
        const b = await lastBooking(v.id);
        await page.reload();
        await page.goto(`${h.uiOrigin}/customer/bookings`);
        await page.waitFor(
          `document.body.innerText.includes(${JSON.stringify(b.reference)})`,
          120000,
        );
        const input = {
          startAt: b.schedule.startAt.toISOString(),
          serviceLines: [
            {
              serviceId: String(v.services.hair),
              staffMembershipId: String(b.serviceLines[0]!.responsibleStaffMembershipId),
              addonIds: [],
              pricingInput: {},
            },
          ],
          idempotencyKey: b.financialContract!.idempotencyKey,
        };
        const replay = await post(
          `/businesses/${v.id}/bookings/finalize`,
          await token(h.seed.accounts.customer),
          input,
        );
        expect([200, 201]).toContain(replay.status);
        expect(await BookingModel.countDocuments({ businessId: v.id })).toBe(1);
        expect(harnessGateway.createdPaymentIntentIds()).toHaveLength(before + 1);
        await SessionModel.updateMany(
          { userId: h.seed.customer },
          { $set: { revokedAt: new Date() } },
        );
        await page.reload();
        await page.waitFor(
          "location.pathname === '/select-role' || location.pathname === '/customer'",
          120000,
        );
        await session(page, h.seed.accounts.customer, "customer", "/customer/bookings");
        await page.waitFor(
          `document.body.innerText.includes(${JSON.stringify(b.reference)})`,
          120000,
        );
        expect(await BookingModel.countDocuments({ businessId: v.id })).toBe(1);
        await page.screenshot("A6-reauthenticated.png");
      }),
    360000,
  );

  it(
    "C7 exhausted foreign invalid staff and competing redemption cannot overconsume",
    () =>
      journey("C7-capacity", async () => {
        const progress = await PackageProgressModel.findById(packageId).orFail();
        expect(progress.remainingSessions).toBe(1);
        const customer = await token(h.seed.accounts.customer);
        const path = `/businesses/${h.seed.venue.id}/bookings/packages/${packageId}/sessions`;
        const availabilityDate = new Date(initialClock);
        availabilityDate.setUTCDate(availabilityDate.getUTCDate() + 10);
        const date = availabilityDate.toISOString().slice(0, 10);
        const available = await api(
          `/catalog/businesses/${h.seed.venue.id}/services/${legacyId}/availability?fromDate=${date}&toDate=${date}&staffMembershipId=${h.seed.venue.memberships[0]!.id}`,
          customer,
        );
        expect(available.status).toBe(200);
        const slot = available.body.data["days"][0].slots[0];
        const input = {
          staffMembershipId: String(h.seed.venue.memberships[0]!.id),
          startAt: slot.startAt,
          addonIds: [],
        };
        const foreign = await post(path, await token(h.seed.accounts.otherCustomer), {
          ...input,
          idempotencyKey: randomUUID(),
        });
        expect([403, 404]).toContain(foreign.status);
        const invalid = await post(path, customer, {
          ...input,
          staffMembershipId: String(h.seed.travel.memberships[0]!.id),
          idempotencyKey: randomUUID(),
        });
        expect([400, 404, 409, 422]).toContain(invalid.status);
        const contenders = await Promise.all([
          post(path, customer, { ...input, idempotencyKey: randomUUID() }),
          post(path, customer, { ...input, idempotencyKey: randomUUID() }),
        ]);
        expect(contenders.filter((r) => [200, 201].includes(r.status))).toHaveLength(1);
        expect(contenders.filter((r) => [409, 422].includes(r.status))).toHaveLength(1);
        expect((await PackageProgressModel.findById(packageId))?.remainingSessions).toBe(0);
        expect([409, 422]).toContain(
          (await post(path, customer, { ...input, idempotencyKey: randomUUID() })).status,
        );
        const terminated = await post(
          `/businesses/${h.seed.venue.id}/bookings/packages/${packageId}/terminate`,
          await token(h.seed.accounts.owner, "professional"),
          {},
        );
        expect(terminated.status).toBe(200);
        expect((await PackageProgressModel.findById(packageId))?.voidedAt).toBeDefined();
        expect([409, 422]).toContain(
          (await post(path, customer, { ...input, idempotencyKey: randomUUID() })).status,
        );
        await page.goto(`${h.uiOrigin}/customer/packages/${packageId}`);
        await page.waitFor("document.body.innerText.includes('Legacy Hair Three')");
        await page.screenshot("C7-terminated.png");
      }),
    240000,
  );
  it(
    "C5 lost paid purchase response retains original identity and one progress",
    () =>
      journey("C5-purchase", async () => {
        const v = await seedP4kPaymentVenue();
        const template = await ServiceModel.findById(v.services.hair).lean().orFail();
        const { _id, fixedPricing: _fixed, ...base } = template;
        const service = await ServiceModel.create({
          ...base,
          name: "Recovered Legacy",
          pricingMode: undefined,
          isPackageDeal: true,
          packagePricing: {
            bundlePriceCents: 10000,
            sessionsInPackage: 2,
            durationMin: 60,
            bookingIntervalMin: 15,
          },
        });
        const before = harnessGateway.createdPaymentIntentIds().length;
        await checkout(String(service._id), { venueId: String(v.id), confirm: false });
        await page.dropNextResponse("/bookings/packages/purchase");
        await page.click("Confirm");
        await expect
          .poll(() => PackageProgressModel.countDocuments({ businessId: v.id }), { timeout: 30000 })
          .toBe(1);
        const progress = await PackageProgressModel.findOne({ businessId: v.id }).orFail();
        const b = await BookingModel.findById(progress.originBookingId).orFail();
        await page.reload();
        await page.waitFor(
          "document.body.innerText.includes('committed') || document.body.innerText.includes('confirmed')",
          120000,
        );
        expect(await PackageProgressModel.countDocuments({ businessId: v.id })).toBe(1);
        expect(await BookingModel.countDocuments({ businessId: v.id })).toBe(1);
        expect(harnessGateway.createdPaymentIntentIds()).toHaveLength(before + 1);
        const status = await api(
          `/businesses/${v.id}/bookings/packages/operations/status?kind=PACKAGE_PURCHASE&packageId=${service._id}&idempotencyKey=${b.financialContract!.idempotencyKey}`,
          await token(h.seed.accounts.customer),
        );
        expect(status.status).toBe(200);
        expect(status.body.data["state"]).toBe("COMMITTED");
        await page.screenshot("C5-purchase-recovered.png");
      }),
    240000,
  );
  it(
    "A6 and C8 unknown provider outcomes stay unconfirmed and recoverable",
    () =>
      journey("A6-C8-unknown", async () => {
        for (const legacy of [false, true]) {
          const v = await seedP4kPaymentVenue();
          let serviceId = String(v.services.hair);
          if (legacy) {
            const template = await ServiceModel.findById(v.services.hair).lean().orFail();
            const { _id, fixedPricing: _fixed, ...base } = template;
            const created = await ServiceModel.create({
              ...base,
              name: "Unknown Legacy",
              pricingMode: undefined,
              isPackageDeal: true,
              packagePricing: {
                bundlePriceCents: 10000,
                sessionsInPackage: 2,
                durationMin: 60,
                bookingIntervalMin: 15,
              },
            });
            serviceId = String(created._id);
          }
          await checkout(serviceId, { venueId: String(v.id), confirm: false });
          harnessGateway.queueNextChargeLostResponse(Error("BC-F06 unknown fake outcome"));
          await page.click("Confirm");
          await page.waitFor(
            "document.body.innerText.toLowerCase().includes('unresolved') || document.body.innerText.toLowerCase().includes('unconfirmed') || document.body.innerText.toLowerCase().includes('unknown') || document.body.innerText.toLowerCase().includes('could not') || document.body.innerText.includes('No Booking result has been observed')",
            120000,
          );
          expect(await page.text()).not.toContain("Booking Confirmed!");
          expect(await BookingModel.countDocuments({ businessId: v.id })).toBe(0);
          expect(await PackageProgressModel.countDocuments({ businessId: v.id })).toBe(0);
          await expect
            .poll(() => PaymentAttemptModel.countDocuments({ businessId: v.id }), {
              timeout: 20000,
            })
            .toBe(1);
          const attempt = await PaymentAttemptModel.findOne({ businessId: v.id }).orFail();
          expect(attempt.logicalIdempotencyKey.length).toBeGreaterThan(0);
          expect(await PaymentAttemptModel.countDocuments({ businessId: v.id })).toBe(1);
          await page.reload();
          await page.waitFor("document.body.innerText.toLowerCase().includes('original')", 120000);
          expect(await page.text()).not.toContain("Booking Confirmed!");
          expect(await PaymentAttemptModel.countDocuments({ businessId: v.id })).toBe(1);
          await page.screenshot(legacy ? "C8-unknown.png" : "A6-unknown.png");
          await writeFile(
            join(artifacts, legacy ? "C8-unknown.json" : "A6-unknown.json"),
            JSON.stringify(
              {
                key: attempt.logicalIdempotencyKey,
                providerStatus: attempt.providerStatus,
                persistenceStatus: attempt.persistenceStatus,
                bookingCount: 0,
                progressCount: 0,
              },
              null,
              2,
            ),
          );
        }
      }),
    480000,
  );
  it(
    "A7 cross-role current membership and protected authority",
    () =>
      journey("A7-roles", async () => {
        if (!returningId) {
          await checkout(String(h.seed.venue.services.facial));
          returningId = String((await lastBooking())._id);
        }
        const staff = h.seed.venue.memberships.find((m) => m.role === "STAFF")!;
        const supervisor = h.seed.venue.memberships.find((m) => m.role === "SUPERVISOR")!;
        const staffToken = await token(h.seed.accounts.staff, "professional");
        const appointments = await api(
          `/businesses/${h.seed.venue.id}/staff/me/appointments`,
          staffToken,
        );
        expect(appointments.status).toBe(200);
        const assigned = await BookingModel.find({
          businessId: h.seed.venue.id,
          "serviceLines.responsibleStaffMembershipId": staff.id,
        });
        for (const b of assigned)
          expect(JSON.stringify(appointments.body.data)).toContain(String(b._id));
        await StaffMembershipModel.updateOne(
          { _id: staff.id },
          { $set: { employmentActive: false } },
        );
        expect([403, 404]).toContain(
          (await api(`/businesses/${h.seed.venue.id}/staff/me/appointments`, staffToken)).status,
        );
        const supervisorToken = await token(h.seed.accounts.supervisor, "professional");
        await StaffMembershipModel.updateOne(
          { _id: supervisor.id },
          { $set: { employmentActive: false } },
        );
        expect([403, 404]).toContain(
          (await api(`/businesses/${h.seed.venue.id}/bookings/${returningId}`, supervisorToken))
            .status,
        );
        await StaffMembershipModel.updateMany(
          { _id: { $in: [staff.id, supervisor.id] } },
          { $set: { employmentActive: true } },
        );
        const { verifyPackageBatchActivation } = await import(
          "../../src/modules/booking/package-batch-authority.js"
        );
        await expect(verifyPackageBatchActivation()).rejects.toMatchObject({
          code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE",
        });
        const { readPackageConsentHttpReadiness, shippedPackageConsentHttpActivation } =
          await import("../../src/modules/booking/package-consent-http-activation.js");
        expect(readPackageConsentHttpReadiness(shippedPackageConsentHttpActivation).state).toBe(
          "DISABLED",
        );
        await writeFile(
          join(artifacts, "A7-role-boundaries.json"),
          JSON.stringify(
            {
              staffRead: 200,
              inactiveStaff: "DENIED",
              inactiveSupervisor: "DENIED",
              batch: "DENIED",
              consent: "DISABLED",
            },
            null,
            2,
          ),
        );
      }),
    180000,
  );
  it(
    "B3 on-time cancellation and released availability",
    () =>
      journey("B3-ontime", async () => {
        await checkout(String(h.seed.venue.services.hair));
        const b = await lastBooking();
        await page.goto(`${h.uiOrigin}/customer/bookings`);
        await page.waitFor(`document.body.innerText.includes(${JSON.stringify(b.reference)})`);
        await cardAction(page, b.reference, "Cancel");
        await page.click("Yes, cancel");
        await page.waitFor("document.body.innerText.includes('Cancellation Confirmed')");
        expect((await BookingModel.findById(b._id))?.status).toBe("CANCELLED_BY_CUSTOMER");
        const date = new Intl.DateTimeFormat("en-CA", { timeZone: b.schedule.timezone }).format(
          b.schedule.startAt,
        );
        const availability = (await fetch(
          `${h.apiOrigin}/api/v1/catalog/businesses/${b.businessId}/services/${b.serviceLines[0]!.serviceId}/availability?fromDate=${date}&toDate=${date}&staffMembershipId=${b.serviceLines[0]!.responsibleStaffMembershipId}`,
          { headers: { authorization: `Bearer ${await token(h.seed.accounts.customer)}` } },
        ).then((r) => r.json())) as {
          data: { days: Array<{ slots: Array<{ startAt: string }> }> };
        };
        expect(
          availability.data.days
            .flatMap((d) => d.slots)
            .some((slot) => slot.startAt === b.schedule.startAt.toISOString()),
        ).toBe(true);
        await crossRole(String(b._id));
        await page.screenshot("B3-ontime.png");
      }),
    240000,
  );
  it(
    "B5 eligible no-show durable declined collection waiver and reversal",
    () =>
      journey("B5", async () => {
        await checkout(String(h.seed.venue.services.hair), { timeLabel: "10:00 AM" });
        const b = await lastBooking();
        const at = new Date(
          b.schedule.startAt.getTime() +
            (b.noShowEligibilitySnapshot?.opensAfterMinutes ?? 15) * 60000 +
            1000,
        );
        vi.setSystemTime(at);
        await page.setClock(at.toISOString());
        await ownerPage.setClock(at.toISOString());
        await session(
          ownerPage,
          h.seed.accounts.owner,
          "professional",
          "/business-dashboard?section=calendar",
        );
        await ownerPage.waitFor(
          "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('Weekly'))",
          180000,
        );
        await ownerPage.click("Weekly");
        await ownerPage.click("Today");
        await ownerPage.waitFor(
          "document.querySelector('h4') && document.body.innerText.includes('Hair')",
          180000,
        );
        await ownerPage.evaluate(
          "Array.from(document.querySelectorAll('h4')).find(e=>e.textContent.includes('Customer A')).closest('div.absolute').click()",
        );
        await ownerPage.click("No-show");
        await ownerPage.waitFor("document.body.innerText.includes('Internal note')");
        await ownerPage.click("Yes");
        await expect
          .poll(async () => (await BookingModel.findById(b._id))?.status, { timeout: 20000 })
          .toBe("PENDING");
        const marked = await BookingModel.findById(b._id).orFail();
        const deadline = new Date(marked.noShowDeadlineAt!.getTime() + 1000);
        vi.setSystemTime(deadline);
        await ownerPage.setClock(deadline.toISOString());
        await page.setClock(deadline.toISOString());
        const bookings = new BookingRepository(),
          businesses = new BusinessRepository(),
          users = new UserRepository();
        const paymentService = new PaymentService(
          harnessGateway,
          new CustomerPaymentProfileRepository(),
          users,
        );
        const financialTransactionService = new BookingFinancialTransactionService(
          new BookingFinancialTransactionRepository(),
        );
        const collector = createPenaltyCollectionService({
          paymentService,
          financialTransactionService,
          bookingRepository: bookings,
          businessRepository: businesses,
          userRepository: users,
        });
        const resolver = new NoShowResolutionService(
          bookings,
          businesses,
          paymentService,
          financialTransactionService,
          undefined,
          undefined,
          collector,
        );
        harnessGateway.queueNextChargeOutcome("failed");
        const before = harnessGateway.createdPaymentIntentIds().length;
        expect(await resolver.autoResolve(b._id)).toBe("charge_failed");
        expect((await BookingModel.findById(b._id))?.noShowChargeClaimedAt).toBeDefined();
        const attempts = await PaymentAttemptModel.find({ bookingId: b._id }).lean();
        expect(attempts.length).toBeGreaterThan(0);
        await resolver.autoResolve(b._id);
        expect(harnessGateway.createdPaymentIntentIds()).toHaveLength(before + 1);
        await session(
          ownerPage,
          h.seed.accounts.owner,
          "professional",
          "/business-dashboard?section=all-bookings",
        );
        await openOwnerBooking(b);
        await ownerPage.click("Waive fee");
        await ownerPage.waitFor("document.body.innerText.includes('waive fee?')");
        await ownerPage.click("Yes");
        await expect
          .poll(async () => (await BookingModel.findById(b._id))?.status, { timeout: 20000 })
          .toBe("NO_SHOW_WAIVED");
        await crossRole(String(b._id));
        await ownerPage.screenshot("B5-waived.png");
        // A distinct genuine booking exercises reversal before the timer is resolved.
        await session(page, h.seed.accounts.customer, "customer", "/customer/bookings");
        await checkout(String(h.seed.venue.services.facial), { timeLabel: "2:00 PM" });
        const reverse = await lastBooking();
        const reverseAt = new Date(
          reverse.schedule.startAt.getTime() +
            (reverse.noShowEligibilitySnapshot?.opensAfterMinutes ?? 15) * 60000 +
            1000,
        );
        vi.setSystemTime(reverseAt);
        await ownerPage.setClock(reverseAt.toISOString());
        await page.setClock(reverseAt.toISOString());
        const markedReverse = await post(
          `/businesses/${reverse.businessId}/bookings/${reverse._id}/no-show`,
          await token(h.seed.accounts.owner, "professional"),
        );
        expect(markedReverse.status).toBe(200);
        await session(
          ownerPage,
          h.seed.accounts.owner,
          "professional",
          "/business-dashboard?section=all-bookings",
        );
        await openOwnerBooking(reverse);
        await ownerPage.click("Cancel No-show");
        await ownerPage.waitFor("document.body.innerText.includes('Cancel this no-show?')");
        await ownerPage.click("Yes");
        await expect
          .poll(async () => (await BookingModel.findById(reverse._id))?.status, { timeout: 20000 })
          .toBe("NO_SHOW_CANCELLED");
        await crossRole(String(reverse._id));
        await ownerPage.screenshot("B5-reversed.png");
      }),
    480000,
  );
  it(
    "C4 Legacy travel redemption freezes free base and paid extras/travel",
    () =>
      journey("C4-travel", async () => {
        await session(page, h.seed.accounts.customer, "customer", "/customer/bookings");
        const template = await ServiceModel.findById(h.seed.travel.services.hair).lean().orFail();
        const { _id: _ignored, fixedPricing: _fixed, ...base } = template;
        const service = await ServiceModel.create({
          ...base,
          name: "Legacy Mobile Two",
          pricingMode: undefined,
          isPackageDeal: true,
          packagePricing: {
            bundlePriceCents: 10000,
            sessionsInPackage: 2,
            durationMin: 60,
            bookingIntervalMin: 15,
          },
        });
        await AddonServiceAssignmentModel.create({
          businessId: h.seed.travel.id,
          serviceId: service._id,
          addonId: h.seed.travel.addonId,
        });
        await checkout(String(service._id), { venueId: String(h.seed.travel.id), travel: true });
        const origin = await BookingModel.findOne({
          businessId: h.seed.travel.id,
          "customer.customerUserId": h.seed.customer,
          "serviceLines.serviceId": service._id,
        })
          .sort({ _id: -1 })
          .orFail();
        const progress = await PackageProgressModel.findById(
          origin.serviceLines[0]!.pricingInput.packageProgressId,
        ).orFail();
        expect(origin.fulfilment.mode).toBe("TRAVEL_TO_CUSTOMER");
        expect(origin.fulfilment.travelAddress?.city).toBe("Larnaca");
        const packageReadback = await api(
          `/me/packages/${progress._id}`,
          await token(h.seed.accounts.customer),
        );
        expect(packageReadback.status).toBe(200);
        expect(packageReadback.body.data["fulfilmentEntitlement"]).toEqual({
          mode: "TRAVEL_TO_CUSTOMER",
          travelCities: [{ city: "Larnaca", feeCents: 300 }],
        });
        await writeFile(
          join(artifacts, "C4-travel-entitlement.json"),
          JSON.stringify(
            {
              originFulfilment: origin.fulfilment,
              storedEntitlement: progress.purchaseSnapshot.fulfilmentEntitlement,
              customerEntitlement: packageReadback.body.data["fulfilmentEntitlement"],
            },
            null,
            2,
          ),
        );
        await session(
          ownerPage,
          h.seed.accounts.travelOwner,
          "professional",
          "/business-dashboard?section=all-bookings",
        );
        await openOwnerBooking(origin);
        await ownerPage.evaluate(
          "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Complete package session').click()",
        );
        await ownerPage.waitFor("document.body.innerText.includes('Did the customer pay')");
        await ownerPage.evaluate(
          "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Yes').click()",
        );
        await expect
          .poll(async () => (await BookingModel.findById(origin._id))?.status, { timeout: 20000 })
          .toBe("COMPLETED");
        const old = packageId;
        packageId = String(progress._id);
        try {
          await redeemUi(true, false, true);
          await expect
            .poll(
              async () => (await PackageProgressModel.findById(progress._id))?.remainingSessions,
              { timeout: 30000 },
            )
            .toBe(0);
        } finally {
          packageId = old;
        }
        const progressAfter = await PackageProgressModel.findById(progress._id).orFail();
        const finalSession = [...progressAfter.sessions].sort(
          (left, right) => right.sessionIndex - left.sessionIndex,
        )[0]!;
        const b = await BookingModel.findById(finalSession.bookingId).orFail();
        expect(b.financials.servicesSubtotalCents).toBe(0);
        expect(b.financials.addonsSubtotalCents).toBe(500);
        expect(b.financials.travelFeeCents).toBe(300);
        expect(b.financials.totalCents).toBe(800);
        expect(b.fulfilment.travelAddress?.city).toBe("Larnaca");
        const owned = await api(`/me/bookings/${b._id}`, await token(h.seed.accounts.customer));
        const business = await api(
          `/businesses/${b.businessId}/bookings/${b._id}`,
          await token(h.seed.accounts.travelOwner, "professional"),
        );
        expect(owned.status).toBe(200);
        expect(business.status).toBe(200);
        expect(owned.body.data["financials"]).toEqual(business.body.data["financials"]);
        await writeFile(
          join(artifacts, "C4-travel-money.json"),
          JSON.stringify(
            { booking: b, customer: owned.body.data, business: business.body.data },
            null,
            2,
          ),
        );
        await page.screenshot("C4-travel.png");
      }),
    360000,
  );
});
