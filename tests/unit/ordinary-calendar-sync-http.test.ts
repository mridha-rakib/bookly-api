import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { asyncHandler } from "../../src/common/middleware/async-handler.js";
import { createErrorHandler } from "../../src/common/middleware/error-handler.js";
import { validateRequest } from "../../src/common/middleware/validate-request.js";
import { OrdinaryCalendarJournalConflictError } from "../../src/modules/booking/ordinary-calendar-journal.js";
import type { OrdinaryCalendarJournalDocument } from "../../src/modules/booking/ordinary-calendar-journal.model.js";
import { OrdinaryCalendarDeliveryUnavailableError } from "../../src/modules/booking/ordinary-calendar-journal-authority.js";
import type { PackageCalendarOwner } from "../../src/modules/booking/package-calendar-authority.js";
import { PackageCalendarProviderError } from "../../src/modules/booking/package-calendar-delivery.js";
import {
  bookingCalendarRecoveryBodySchema,
  bookingCalendarSyncParamsSchema,
} from "../../src/modules/integration/integration.schema.js";
import {
  OrdinaryCalendarSyncController,
  type OrdinaryCalendarSyncControllerDependencies,
} from "../../src/modules/integration/ordinary-calendar-sync.controller.js";

// P4B-2C — the Owner status/recovery HTTP contract, with the recovery service mocked. The
// service's own owner, request, quiescence and destination rules are covered on a replica set
// in tests/integration/database/ordinary-calendar-delivery.integration.test.ts.

const ownerId = new Types.ObjectId().toHexString();
const businessId = new Types.ObjectId().toHexString();
const bookingId = new Types.ObjectId().toHexString();
const foreignBusinessId = new Types.ObjectId().toHexString();
const requestId = "0b6c6d7e-7f3a-4b1c-9d2e-3f4a5b6c7d8e";
const proof = Object.freeze({}) as PackageCalendarOwner;

const journal = (overrides: Partial<OrdinaryCalendarJournalDocument> = {}) =>
  ({
    _id: new Types.ObjectId(),
    bookingId: new Types.ObjectId(bookingId),
    businessId: new Types.ObjectId(businessId),
    mode: "AUTHORITATIVE",
    state: "UNKNOWN_OUTCOME",
    reason: "UNRESOLVED_REQUEST_REQUIRES_QUIESCENCE_DECISION",
    createIssued: true,
    request: {
      id: requestId,
      kind: "INSERT",
      sequence: 1,
      revision: "r".repeat(64),
      issuedAt: new Date(0),
      settled: false,
      providerStarted: true,
    },
    latest: { sequence: 1, revision: "r".repeat(64), desired: { kind: "PRESENT" } },
    destination: {
      integrationId: new Types.ObjectId(),
      generation: "g-1",
      accountId: "acct-1",
      accountEmail: "owner@example.com",
      configuredCalendarId: "primary",
    },
    ...overrides,
  }) as unknown as OrdinaryCalendarJournalDocument;

const build = (overrides: Partial<OrdinaryCalendarSyncControllerDependencies> = {}) => {
  const deps = {
    ownsBusiness: vi.fn(
      async (userId: string, id: string) => userId === ownerId && id === businessId,
    ),
    bookingBelongsToBusiness: vi.fn(
      async (booking: string, business: string) => booking === bookingId && business === businessId,
    ),
    readJournal: vi.fn(async () => journal() as OrdinaryCalendarJournalDocument | null),
    authenticateOwner: vi.fn(async (authorization: string | undefined) => {
      if (authorization !== "Bearer live-owner-session")
        throw new Error("PackageCheckoutConflictError");
      return proof;
    }),
    recover: vi.fn(
      async () =>
        journal({
          state: "RETRYABLE_FAILURE",
          reason: "RECOVERED_BY_OWNER",
          request: {
            id: requestId,
            kind: "INSERT",
            sequence: 1,
            revision: "r".repeat(64),
            issuedAt: new Date(0),
            settled: true,
            providerStarted: true,
          },
          recoveries: [
            {
              actorUserId: new Types.ObjectId(ownerId),
              sessionFamilyId: "sid-1",
              incidentReference: "INC-9",
              assertion: "ALL_ISSUERS_QUIESCED_AND_PROVIDER_SETTLED",
              binding: "UNCHANGED",
              requestId,
              previousGeneration: "g-1",
              generation: "g-1",
              at: new Date(),
            },
          ],
        }) as Awaited<ReturnType<OrdinaryCalendarSyncControllerDependencies["recover"]>>,
    ),
    ...overrides,
  };
  const controller = new OrdinaryCalendarSyncController(
    deps as OrdinaryCalendarSyncControllerDependencies,
  );
  const app = express();
  app.use(express.json());
  // Stands in for the Business router's authenticate + BUSINESS_OWNER gates.
  app.use((req, _res, next) => {
    const user = req.header("x-test-user");
    if (user) req.auth = { userId: user, role: "BUSINESS_OWNER", status: "ACTIVE" };
    next();
  });
  const path = "/businesses/:businessId/bookings/:bookingId/calendar-sync";
  app.get(
    path,
    validateRequest({ params: bookingCalendarSyncParamsSchema }),
    asyncHandler(controller.getStatus),
  );
  app.post(
    `${path}/recovery`,
    validateRequest({
      params: bookingCalendarSyncParamsSchema,
      body: bookingCalendarRecoveryBodySchema,
    }),
    asyncHandler(controller.recover),
  );
  app.use(createErrorHandler({ isProduction: true }));
  return { app, deps };
};

const url = (business = businessId, booking = bookingId) =>
  `/businesses/${business}/bookings/${booking}/calendar-sync`;
const attested = {
  incidentReference: "INC-9",
  assertion: "ALL_ISSUERS_QUIESCED_AND_PROVIDER_SETTLED",
  requestId,
};

describe("ordinary Calendar sync status HTTP", () => {
  it("reports a legacy-owned Booking as untracked, never as synchronized", async () => {
    const { app } = build({ readJournal: vi.fn(async () => null) });
    const response = await request(app).get(url()).set("x-test-user", ownerId);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      ownership: "LEGACY",
      status: "LEGACY_UNTRACKED",
      recoveryRequired: false,
    });
  });

  it("reports the exact unresolved request an Owner must name, without secrets", async () => {
    const { app } = build();
    const response = await request(app).get(url()).set("x-test-user", ownerId);
    expect(response.body.data).toMatchObject({
      ownership: "JOURNAL",
      status: "RECOVERY_REQUIRED",
      incident: "PROVIDER_OUTCOME_UNKNOWN",
      unresolvedRequestId: requestId,
      destination: { accountEmail: "owner@example.com", configuredCalendarId: "primary" },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/integrationId|token|encrypted/i);
  });

  it("requires a session and hides foreign Businesses and Bookings behind the same 404", async () => {
    const { app, deps } = build();
    expect((await request(app).get(url())).status).toBe(401);
    expect(
      (await request(app).get(url(foreignBusinessId)).set("x-test-user", ownerId)).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .get(url(businessId, new Types.ObjectId().toHexString()))
          .set("x-test-user", ownerId)
      ).status,
    ).toBe(404);
    expect(
      (await request(app).get(url()).set("x-test-user", new Types.ObjectId().toHexString())).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .get("/businesses/not-an-id/bookings/x/calendar-sync")
          .set("x-test-user", ownerId)
      ).status,
    ).toBe(400);
    expect(deps.readJournal).not.toHaveBeenCalled();
  });
});

describe("ordinary Calendar Owner recovery HTTP", () => {
  it("uses the authenticated session as the actor and the live Owner session proof", async () => {
    const { app, deps } = build();
    const response = await request(app)
      .post(`${url()}/recovery`)
      .set("x-test-user", ownerId)
      .set("Authorization", "Bearer live-owner-session")
      .send(attested);
    expect(response.status).toBe(200);
    expect(deps.recover).toHaveBeenCalledWith(
      {
        bookingId,
        businessId,
        actorUserId: ownerId,
        incidentReference: "INC-9",
        assertion: "ALL_ISSUERS_QUIESCED_AND_PROVIDER_SETTLED",
        requestId,
      },
      proof,
    );
    expect(response.body.data).toMatchObject({
      sync: { status: "SYNC_PENDING", ownership: "JOURNAL" },
      recovery: { binding: "UNCHANGED", requestId, incidentReference: "INC-9" },
    });
  });

  it("rejects posted Owner ids, destinations, forced flags and malformed evidence", async () => {
    const { app, deps } = build();
    const post = (body: Record<string, unknown>) =>
      request(app)
        .post(`${url()}/recovery`)
        .set("x-test-user", ownerId)
        .set("Authorization", "Bearer live-owner-session")
        .send(body);
    for (const body of [
      { ...attested, actorUserId: new Types.ObjectId().toHexString() },
      { ...attested, ownerUserId: ownerId },
      { ...attested, destination: { accountId: "acct-2" } },
      { ...attested, force: true },
      { ...attested, incidentReference: "   " },
      { ...attested, requestId: "not-a-uuid" },
      { incidentReference: "INC-9", assertion: "ALL_ISSUERS_QUIESCED_AND_PROVIDER_SETTLED" },
      { incidentReference: "INC-9", assertion: "NO_UNRESOLVED_REQUEST", requestId },
      { incidentReference: "INC-9", assertion: "TRUST_ME" },
      {
        incidentReference: "INC-9",
        assertion: "NO_UNRESOLVED_REQUEST",
        rebindToCurrentConnection: true,
        bindUnusedDestination: true,
      },
    ])
      expect((await post(body)).status).toBe(400);
    expect(deps.recover).not.toHaveBeenCalled();
  });

  it("requires a verifiable live Owner session and an owned Business and Booking", async () => {
    const { app, deps } = build();
    expect((await request(app).post(`${url()}/recovery`).send(attested)).status).toBe(401);
    expect(
      (await request(app).post(`${url()}/recovery`).set("x-test-user", ownerId).send(attested))
        .status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post(`${url()}/recovery`)
          .set("x-test-user", ownerId)
          .set("Authorization", "Bearer forged")
          .send(attested)
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post(`${url(foreignBusinessId)}/recovery`)
          .set("x-test-user", ownerId)
          .set("Authorization", "Bearer live-owner-session")
          .send(attested)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post(`${url()}/recovery`)
          .set("x-test-user", new Types.ObjectId().toHexString())
          .set("Authorization", "Bearer live-owner-session")
          .send(attested)
      ).status,
    ).toBe(404);
    expect(deps.recover).not.toHaveBeenCalled();
  });

  it("maps the default-denied rollout to 503 and refused evidence or destinations to 409", async () => {
    const cases: Array<[Error, number]> = [
      [new OrdinaryCalendarDeliveryUnavailableError(), 503],
      [
        new OrdinaryCalendarJournalConflictError(
          "A different Google account or calendar is never adopted automatically",
        ),
        409,
      ],
      [
        new OrdinaryCalendarJournalConflictError(
          "Recovery must name the exact unresolved request and attest its settlement",
        ),
        409,
      ],
      [new PackageCalendarProviderError("BLOCKED_AUTHORITY", true), 409],
    ];
    for (const [error, status] of cases) {
      const { app } = build({
        recover: vi.fn(async () => {
          throw error;
        }),
      });
      const response = await request(app)
        .post(`${url()}/recovery`)
        .set("x-test-user", ownerId)
        .set("Authorization", "Bearer live-owner-session")
        .send(attested);
      expect(response.status).toBe(status);
    }
  });
});
