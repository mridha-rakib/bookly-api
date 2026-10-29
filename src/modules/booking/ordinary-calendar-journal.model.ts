import { model, Schema, type Types } from "mongoose";

/**
 * P4B-2A — durable desired-state journal for an ORDINARY Booking's Google Calendar event.
 *
 * One row per Booking, written only inside the Booking transaction that creates, reschedules or
 * cancels it. It is additive and separate from P2C's `Booking.packageCalendarDelivery` journal:
 * First-Class Package Bookings never get a row here, and nothing here can release or observe a
 * Package task. See ordinary-calendar-journal.ts for the contract and transition rules.
 */
export const ordinaryCalendarJournalModes = ["SHADOW", "AUTHORITATIVE"] as const;
export type OrdinaryCalendarJournalMode = (typeof ordinaryCalendarJournalModes)[number];

export const ordinaryCalendarJournalStates = [
  "PENDING",
  "DISPATCH_PREPARED",
  "REQUEST_ISSUED",
  "CONFIRMED",
  "UNKNOWN_OUTCOME",
  "RETRYABLE_FAILURE",
  "BLOCKED_AUTHORITY",
  "PERMANENT_FAILURE",
] as const;
export type OrdinaryCalendarJournalState = (typeof ordinaryCalendarJournalStates)[number];

export type OrdinaryCalendarDesired =
  | {
      kind: "PRESENT";
      summary: string;
      description: string;
      startAt: Date;
      endAt: Date;
      timezone: string;
    }
  | { kind: "ABSENT" };

export type OrdinaryCalendarDestination = {
  integrationId: Types.ObjectId;
  generation: string;
  accountId: string;
  accountEmail: string;
  configuredCalendarId: string;
};

export type OrdinaryCalendarRequest = {
  id: string;
  kind: "INSERT" | "PATCH" | "DELETE";
  sequence: number;
  revision: string;
  issuedAt: Date;
  settled: boolean;
  providerStarted: boolean;
  etag?: string | undefined;
};

export type OrdinaryCalendarJournalDocument = {
  _id: Types.ObjectId;
  version: 1;
  bookingId: Types.ObjectId;
  businessId: Types.ObjectId;
  customerUserId?: Types.ObjectId | undefined;
  businessClientId?: Types.ObjectId | undefined;
  /** SHADOW: the existing best-effort path still owns every provider write for this Booking.
   * AUTHORITATIVE: only the journal consumer may write; the legacy path is skipped. Fixed for
   * the life of the row; chosen once, inside the creating Booking transaction. */
  mode: OrdinaryCalendarJournalMode;
  eventIdentity:
    | { kind: "LEGACY_PATH"; eventId?: undefined }
    | { kind: "ALLOCATED"; eventId: string };
  /** Bound from the committed connection row at creation. Never silently rebound. */
  destination?: OrdinaryCalendarDestination | undefined;
  latest: {
    sequence: number;
    revision: string;
    desired: OrdinaryCalendarDesired;
    source: "CREATED" | "RESCHEDULED" | "CANCELLED";
    bookingStatus: string;
    eventVersion: number;
    rescheduleVersion: number;
    recordedAt: Date;
  };
  state: OrdinaryCalendarJournalState;
  /** Durable once an INSERT was issued. Never cleared by a timeout, a GET 404 or a later
   * mutation; only a definitive no-effect provider answer for that exact request clears it. */
  createIssued: boolean;
  request?: OrdinaryCalendarRequest | undefined;
  lease?: { token: string; expiresAt: Date } | undefined;
  confirmedSequence?: number | undefined;
  confirmedRevision?: string | undefined;
  nextAttemptAt?: Date | undefined;
  reason?: string | undefined;
  /** P4B-2C — consecutive retryable/unknown provider answers since the last confirmation. */
  retryableFailures?: number | undefined;
  /** P4B-2B — explicit Owner recovery decisions, append-only audit. */
  recoveries?:
    | Array<{
        actorUserId: Types.ObjectId;
        sessionFamilyId: string;
        incidentReference: string;
        assertion: "ALL_ISSUERS_QUIESCED_AND_PROVIDER_SETTLED" | "NO_UNRESOLVED_REQUEST";
        /** P4B-2C — the Owner explicitly bound a Booking that never had a Calendar write. */
        binding?: "SAME_ACCOUNT_REBIND" | "UNUSED_DESTINATION_BIND" | "UNCHANGED" | undefined;
        requestId?: string | undefined;
        /** Absent for an explicit first binding of a Booking that never had a destination. */
        previousGeneration?: string | undefined;
        generation: string;
        at: Date;
      }>
    | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const desiredSchema = new Schema(
  {
    kind: { type: String, enum: ["PRESENT", "ABSENT"], required: true },
    summary: { type: String },
    description: { type: String },
    startAt: { type: Date },
    endAt: { type: Date },
    timezone: { type: String },
  },
  { _id: false },
);

const schema = new Schema<OrdinaryCalendarJournalDocument>(
  {
    version: { type: Number, enum: [1], required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    customerUserId: { type: Schema.Types.ObjectId, ref: "User" },
    businessClientId: { type: Schema.Types.ObjectId, ref: "Client" },
    mode: { type: String, enum: ordinaryCalendarJournalModes, required: true },
    eventIdentity: {
      type: new Schema(
        {
          kind: { type: String, enum: ["LEGACY_PATH", "ALLOCATED"], required: true },
          eventId: { type: String },
        },
        { _id: false },
      ),
      required: true,
    },
    destination: {
      type: new Schema(
        {
          integrationId: { type: Schema.Types.ObjectId, required: true },
          generation: { type: String, required: true },
          accountId: { type: String, required: true },
          accountEmail: { type: String, required: true },
          configuredCalendarId: { type: String, required: true },
        },
        { _id: false },
      ),
    },
    latest: {
      type: new Schema(
        {
          sequence: { type: Number, required: true, min: 1 },
          revision: { type: String, required: true, minlength: 64, maxlength: 64 },
          desired: { type: desiredSchema, required: true },
          source: { type: String, enum: ["CREATED", "RESCHEDULED", "CANCELLED"], required: true },
          bookingStatus: { type: String, required: true },
          eventVersion: { type: Number, required: true, min: 0 },
          rescheduleVersion: { type: Number, required: true, min: 0 },
          recordedAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      required: true,
    },
    state: { type: String, enum: ordinaryCalendarJournalStates, required: true },
    createIssued: { type: Boolean, required: true, default: false },
    request: {
      type: new Schema(
        {
          id: { type: String, required: true },
          kind: { type: String, enum: ["INSERT", "PATCH", "DELETE"], required: true },
          sequence: { type: Number, required: true },
          revision: { type: String, required: true },
          issuedAt: { type: Date, required: true },
          settled: { type: Boolean, required: true },
          providerStarted: { type: Boolean, required: true },
          etag: { type: String },
        },
        { _id: false },
      ),
    },
    lease: {
      type: new Schema(
        { token: { type: String, required: true }, expiresAt: { type: Date, required: true } },
        { _id: false },
      ),
    },
    confirmedSequence: { type: Number },
    confirmedRevision: { type: String },
    nextAttemptAt: { type: Date },
    reason: { type: String, maxlength: 200 },
    retryableFailures: { type: Number, min: 0 },
    recoveries: {
      type: [
        new Schema(
          {
            actorUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
            sessionFamilyId: { type: String, required: true },
            incidentReference: { type: String, required: true, maxlength: 200 },
            assertion: {
              type: String,
              required: true,
              enum: ["ALL_ISSUERS_QUIESCED_AND_PROVIDER_SETTLED", "NO_UNRESOLVED_REQUEST"],
            },
            requestId: { type: String },
            binding: {
              type: String,
              enum: ["SAME_ACCOUNT_REBIND", "UNUSED_DESTINATION_BIND", "UNCHANGED"],
            },
            previousGeneration: { type: String },
            generation: { type: String, required: true },
            at: { type: Date, required: true },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },
  },
  { timestamps: true },
);

// One journal per Booking: replay of the same creation can never produce a second row.
schema.index({ bookingId: 1 }, { unique: true });
// The future P4B-2B consumer's bounded due query. SHADOW rows are never dispatched.
schema.index({ mode: 1, state: 1, nextAttemptAt: 1 });

export const OrdinaryCalendarJournalModel = model<OrdinaryCalendarJournalDocument>(
  "OrdinaryCalendarJournal",
  schema,
);
