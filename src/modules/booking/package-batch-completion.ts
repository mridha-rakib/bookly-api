import { isDeepStrictEqual } from "node:util";
import type { ClientSession } from "mongoose";
import { AppointmentReminderModel } from "../appointment-reminder/appointment-reminder.model.js";
import { buildAppointmentReminderDedupeKey } from "../appointment-reminder/appointment-reminder.types.js";
import { BookingFinancialTransactionModel } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import { BusinessModel } from "../business/business.model.js";
import { BusinessClientModel } from "../client/client.model.js";
import { buildBookingEmailData } from "../email/templates/booking/booking-email-data.js";
import { EmailOutboxModel } from "../email-outbox/email-outbox.model.js";
import { PaymentAttemptModel } from "../payment/payment-attempt.model.js";
import { assertPaymentBatchBinding } from "../payment/payment-batch-binding.js";
import { UserModel } from "../user/user.model.js";
import type { BookingCreationClaimDocument } from "./booking-creation-claim.model.js";
import { loadOwnedPackageBatch, type PackageBatchScope } from "./booking-creation-claim.model.js";
import { calculateFirstUpfrontCents } from "./financial-contract.js";
import { batchCompletionSchema, batchFinanceSchema } from "./package-batch-completion-contract.js";
import {
  assertBatchPreparation,
  batchConflict,
  canonicalPackageBatch,
} from "./package-batch-contract.js";
import { verifyPackageBatchMembers } from "./package-batch-membership.js";
import { hashCanonicalPackageCheckoutContent as digest } from "./package-checkout-binding.js";
import { verifyCertifiedPackageConsent } from "./package-consent-certification.js";

export function assertCanonicalBatchFinance(claim: BookingCreationClaimDocument, input: unknown) {
  const finance = batchFinanceSchema.parse(input);
  const p = assertBatchPreparation(claim, claim.packageBatchPreparation);
  const { quote: q } = canonicalPackageBatch(claim);
  const c = finance.contract;
  const origin = q.financials.appointments.find((a) => a.bookingId.equals(p.originBookingId));
  if (
    !origin ||
    finance.preparationHash !== digest(p) ||
    c.idempotencyKey !== p.idempotencyKey ||
    !c.bookingId.equals(p.originBookingId) ||
    !c.customerUserId.equals(p.customerUserId) ||
    !c.businessId.equals(p.businessId) ||
    !c.businessClientId.equals(p.businessClientId) ||
    c.classification !== q.financials.classification ||
    c.packageBundlePriceCents !== q.financials.bundlePriceCents ||
    c.eligibleBasisCents !== q.financials.bundlePriceCents ||
    c.requiredUpfrontCents !==
      (c.classification === "FIRST" ? calculateFirstUpfrontCents(c.eligibleBasisCents) : 0) ||
    c.requiredUpfrontCents !== q.financials.requiredUpfrontCents ||
    c.onlineChargeCents !== c.requiredUpfrontCents ||
    c.bookingTotalCents !== origin.includedBaseCents + origin.addonsCents + origin.travelCents ||
    c.travelFeeCents !== origin.travelCents
  )
    throw batchConflict();
  return finance;
}

export async function verifyBatchCompletion(
  claim: BookingCreationClaimDocument,
  session?: ClientSession,
  initial = false,
) {
  if (session && !session.inTransaction()) throw batchConflict();
  if (claim.packageBatchControl?.phase !== "PREPARATION_COMPLETE") throw batchConflict();
  const internal = await verifyPackageBatchMembers(
    claim,
    claim.packageBatchMaterialization,
    session,
    initial,
  );
  const { preparation: p, bookings } = internal;
  const finance = assertCanonicalBatchFinance(claim, claim.packageBatchFinance);
  const proof = batchCompletionSchema.parse(claim.packageBatchCompletion);
  if (proof.version === 2) {
    const certified = await verifyCertifiedPackageConsent(claim, session);
    if (
      !proof.consentCertificateId.equals(certified.certificateId) ||
      proof.consentCertificateHash !== certified.certificateHash
    )
      throw batchConflict();
  }
  const c = finance.contract;
  if (proof.preparationHash !== digest(p) || proof.financeHash !== digest(finance))
    throw batchConflict();
  const origin = bookings.find((b) => b._id.equals(p.originBookingId));
  if (!origin || !isDeepStrictEqual(origin.financialContract, c)) throw batchConflict();
  for (const b of bookings) {
    if (b._id.equals(p.originBookingId)) {
      if (
        b.financials.depositCents !== c.requiredUpfrontCents ||
        b.financials.platformFeeCents !==
          (c.classification === "FIRST" ? c.requiredUpfrontCents : 0)
      )
        throw batchConflict();
    } else if (
      b.financialContract ||
      b.financials.servicesSubtotalCents !== 0 ||
      b.financials.depositCents !== 0 ||
      b.financials.platformFeeCents !== 0
    )
      throw batchConflict();
  }
  if (initial) {
    const ledgers = await BookingFinancialTransactionModel.find({
      bookingId: { $in: p.members.map((m) => m.bookingId) },
      type: { $in: ["PLATFORM_FEE", "DEPOSIT"] },
      direction: "DEBIT",
    })
      .session(session ?? null)
      .read("primary")
      .maxTimeMS(2000);
    if (ledgers.length !== (c.onlineChargeCents > 0 ? 1 : 0)) throw batchConflict();
  }
  if (c.onlineChargeCents > 0) {
    if (!proof.paymentAttemptId || !proof.ledgerId) throw batchConflict();
    const attempt = await PaymentAttemptModel.findById(proof.paymentAttemptId)
      .session(session ?? null)
      .read("primary")
      .maxTimeMS(2000);
    const ledger = await BookingFinancialTransactionModel.findById(proof.ledgerId)
      .session(session ?? null)
      .read("primary")
      .maxTimeMS(2000);
    if (!attempt || !ledger) throw batchConflict();
    const binding = assertPaymentBatchBinding(attempt);
    if (
      binding.claimId !== String(p.claimId) ||
      binding.termsHash !== p.termsHash ||
      binding.acceptanceId !== String(p.acceptanceId) ||
      binding.batchId !== String(p.batchId) ||
      binding.quoteId !== String(p.quoteId) ||
      attempt.logicalIdempotencyKey !== p.idempotencyKey ||
      attempt.relationshipClassification !== c.classification ||
      attempt.expectedAmountCents !== c.onlineChargeCents ||
      attempt.persistenceStatus !== "COMPLETED" ||
      attempt.providerStatus !== "SUCCEEDED" ||
      (initial && attempt.compensationStatus !== "NOT_REQUIRED") ||
      !attempt.succeededTransactionId?.equals(ledger._id) ||
      !ledger.bookingId.equals(p.originBookingId) ||
      !ledger.businessId.equals(p.businessId) ||
      !ledger.businessClientId.equals(p.businessClientId) ||
      !ledger.customerUserId?.equals(p.customerUserId) ||
      ledger.type !== c.upfrontLedgerType ||
      ledger.direction !== "DEBIT" ||
      ledger.status !== "SUCCEEDED" ||
      ledger.amountCents !== c.onlineChargeCents ||
      ledger.currency !== "EUR" ||
      ledger.providerReference !== attempt.providerPaymentIntentId ||
      ledger.idempotencyKey !== `${p.idempotencyKey}:deposit`
    )
      throw batchConflict();
  } else {
    if (
      proof.paymentAttemptId ||
      proof.ledgerId ||
      (await PaymentAttemptModel.exists({ logicalIdempotencyKey: p.idempotencyKey })
        .session(session ?? null)
        .read("primary")
        .maxTimeMS(2000))
    )
      throw batchConflict();
  }
  if (initial && c.classification === "RETURNING") {
    const client = await BusinessClientModel.findById(p.businessClientId)
      .session(session ?? null)
      .maxTimeMS(2000);
    if (client?.financialRelationship?.state !== "CONSUMED") throw batchConflict();
  }
  if (initial && c.classification === "FIRST") {
    const client = await BusinessClientModel.findById(p.businessClientId).session(session ?? null);
    const consumed = client?.financialRelationship?.consumed;
    if (
      client?.financialRelationship?.state !== "CONSUMED" ||
      consumed?.idempotencyKey !== p.idempotencyKey ||
      !consumed.bookingId.equals(p.originBookingId) ||
      (proof.ledgerId && !consumed.financialTransactionId?.equals(proof.ledgerId))
    )
      throw batchConflict();
  }
  // Expected membership is an immutable set; processing/terminal delivery state may evolve.
  const tasks = claim.packageBatchDelivery;
  if (
    !tasks ||
    tasks.length !== proof.tasks.length ||
    new Set(tasks.map((t) => t.key)).size !== tasks.length
  )
    throw batchConflict();
  for (const t of proof.tasks) {
    const actual = tasks.find((a) => a.key === t.key);
    const m = p.members.find((a) => a.bookingId.equals(t.bookingId));
    if (
      !actual ||
      !m ||
      actual.port !== t.port ||
      !actual.bookingId.equals(t.bookingId) ||
      actual.lifecycleVersion !== t.lifecycleVersion ||
      actual.startAt.getTime() !== t.startAt.getTime() ||
      actual.endAt.getTime() !== t.endAt.getTime() ||
      t.startAt.getTime() !== m.startAt.getTime() ||
      t.endAt.getTime() !== m.endAt.getTime() ||
      t.key !== `${p.batchId}:${m.bookingId}:CREATED:v0:${t.port}`
    )
      throw batchConflict();
  }
  if (
    new Set(proof.emails.map((e) => String(e.id))).size !== proof.emails.length ||
    new Set(proof.reminders.map((e) => String(e.id))).size !== proof.reminders.length
  )
    throw batchConflict();
  const emailRows = [];
  for (const e of proof.emails) {
    const row = await EmailOutboxModel.findOne({ _id: e.id, dedupeKey: e.dedupeKey })
      .session(session ?? null)
      .read("primary")
      .maxTimeMS(2000);
    if (!row || digest(row.payload) !== e.payloadHash) throw batchConflict();
    emailRows.push(row);
  }
  const business = initial
    ? await BusinessModel.findById(p.businessId)
        .session(session ?? null)
        .orFail()
    : null;
  const owner = business
    ? await UserModel.findById(business.ownerUserId).session(session ?? null)
    : null;
  for (const m of p.members) {
    const event = `BOOKING_CREATED:${m.bookingId}`;
    const booking = bookings.find((b) => b._id.equals(m.bookingId));
    if (
      emailRows.filter(
        (e) =>
          e.eventKey === event &&
          e.templateKey === "BOOKING_CUSTOMER_CONFIRMED" &&
          e.recipient === booking?.customer.contact.normalizedEmail,
      ).length !== 1 ||
      proof.tasks.filter((t) => t.bookingId.equals(m.bookingId) && t.port === "CALENDAR").length !==
        1 ||
      emailRows.filter((e) => e.eventKey === event && e.templateKey === "BOOKING_OWNER_NEW_BOOKING")
        .length +
        proof.tasks.filter((t) => t.bookingId.equals(m.bookingId) && t.port === "OWNER_EMAIL")
          .length !==
        1
    )
      throw batchConflict();
    const ownerTaskCount = proof.tasks.filter(
      (t) => t.bookingId.equals(m.bookingId) && t.port === "OWNER_EMAIL",
    ).length;
    if (emailRows.filter((e) => e.eventKey === event).length !== 2 - ownerTaskCount)
      throw batchConflict();
    if (initial && business && booking) {
      if (ownerTaskCount !== (owner ? 0 : 1)) throw batchConflict();
      for (const e of emailRows.filter((e) => e.eventKey === event)) {
        const customer = e.templateKey === "BOOKING_CUSTOMER_CONFIRMED";
        if (
          e.recipient !==
            (customer ? booking.customer.contact.normalizedEmail : owner?.normalizedEmail) ||
          digest(e.payload) !==
            digest({
              ...buildBookingEmailData(booking, {
                businessName: business.name,
                includeCustomerBookingLink: customer,
              }),
            })
        )
          throw batchConflict();
      }
    }
    const expected = buildAppointmentReminderDedupeKey(
      "REMINDER_24H",
      String(m.bookingId),
      m.startAt,
    );
    const entry = proof.reminders.find((r) => r.dedupeKey === expected);
    if (
      !entry ||
      !(await AppointmentReminderModel.exists({
        _id: entry.id,
        dedupeKey: expected,
        bookingId: m.bookingId,
        businessId: p.businessId,
        customerUserId: p.customerUserId,
      })
        .session(session ?? null)
        .read("primary")
        .maxTimeMS(2000))
    )
      throw batchConflict();
  }
  const expectedReminders =
    p.members.length + bookings.filter((b) => b.sessionEndReminderSnapshot?.enabled).length;
  for (const b of bookings.filter((b) => b.sessionEndReminderSnapshot?.enabled)) {
    const m = p.members.find((m) => m.bookingId.equals(b._id));
    if (!m) throw batchConflict();
    const key = buildAppointmentReminderDedupeKey("SESSION_END_REMINDER", String(b._id), m.endAt);
    const e = proof.reminders.find((e) => e.dedupeKey === key);
    const offset = b.sessionEndReminderSnapshot?.minutesBeforeSessionEnds;
    if (
      !e ||
      offset === undefined ||
      !(await AppointmentReminderModel.exists({
        _id: e.id,
        dedupeKey: key,
        bookingId: b._id,
        businessId: p.businessId,
        customerUserId: p.customerUserId,
        offsetMinutes: offset,
      })
        .session(session ?? null)
        .read("primary")
        .maxTimeMS(2000))
    )
      throw batchConflict();
  }
  if (
    proof.reminders.length !== expectedReminders ||
    emailRows.some(
      (e) =>
        !["BOOKING_CUSTOMER_CONFIRMED", "BOOKING_OWNER_NEW_BOOKING"].includes(e.templateKey) ||
        !p.members.some((m) => e.eventKey === `BOOKING_CREATED:${m.bookingId}`),
    )
  )
    throw batchConflict();
  return { ...internal, kind: proof.state, finance, completion: proof };
}

export async function readOwnedPackageBatchCompletion(scope: PackageBatchScope) {
  const row = await loadOwnedPackageBatch(scope);
  if (!row.packageBatchCompletion) return null;
  return verifyBatchCompletion(row.toObject());
}
