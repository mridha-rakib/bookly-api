import type { Request, Response } from "express";
import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import { createPaymentRoute } from "../../src/modules/payment/payment.route.js";
import { savedPaymentMethodParamsSchema } from "../../src/modules/payment/payment.schema.js";
import { SavedCardRemovalService } from "../../src/modules/payment/saved-card-removal.service.js";
import { classifyDetachError } from "../../src/modules/payment/stripe-payment-gateway.js";

const userId = String(new Types.ObjectId());
const OWN = "cus_own";

/** In-memory single-card profile + Stripe state, with the exact CAS semantics of the repo. */
const build = (
  options: {
    owner?:
      | { outcome: "FOUND"; customerId: string | null; isCard: boolean }
      | { outcome: "NOT_FOUND" }
      | { outcome: "UNCERTAIN" };
    detach?: "DETACHED" | "NOT_FOUND" | "NOT_ATTACHED" | "REJECTED" | "UNCERTAIN";
    recheck?:
      | { outcome: "FOUND"; customerId: string | null; isCard: boolean }
      | { outcome: "NOT_FOUND" }
      | { outcome: "UNCERTAIN" };
    unsettled?: readonly boolean[];
    activeBooking?: readonly boolean[];
    localCard?: string | undefined;
  } = {},
) => {
  const profile: Record<string, unknown> = {
    userId,
    stripeCustomerId: OWN,
    ...(options.localCard !== undefined
      ? {
          defaultPaymentMethodId: options.localCard,
          cardBrand: "visa",
          cardLast4: "4242",
          cardExpMonth: 12,
          cardExpYear: 2030,
        }
      : {}),
  };
  const lookups = [
    options.owner ?? { outcome: "FOUND", customerId: OWN, isCard: true },
    options.recheck ?? { outcome: "UNCERTAIN" },
  ];
  const unsettled = [...(options.unsettled ?? [false, false])];
  const active = [...(options.activeBooking ?? [false, false])];
  const gateway = {
    lookupPaymentMethodOwner: vi.fn(
      async () => lookups.shift() ?? { outcome: "UNCERTAIN" as const },
    ),
    detachPaymentMethod: vi.fn(async () => ({ outcome: options.detach ?? ("DETACHED" as const) })),
    createAndConfirmPaymentIntent: vi.fn(),
    createRefund: vi.fn(),
  };
  const profiles = {
    findByUserId: vi.fn(async () => ({ ...profile })),
    clearPaymentMethodIfCurrent: vi.fn(async (_u: unknown, pm: string) => {
      if (profile["defaultPaymentMethodId"] !== pm) return null;
      const before = { ...profile };
      for (const key of [
        "defaultPaymentMethodId",
        "cardBrand",
        "cardLast4",
        "cardExpMonth",
        "cardExpYear",
      ])
        delete profile[key];
      return before;
    }),
    restorePaymentMethodIfEmpty: vi.fn(async (_u: unknown, previous: Record<string, unknown>) => {
      if (!profile["defaultPaymentMethodId"]) Object.assign(profile, previous);
    }),
  };
  const attempts = { hasUnsettledForCustomer: vi.fn(async () => unsettled.shift() ?? false) };
  const bookings = { hasActiveForCustomer: vi.fn(async () => active.shift() ?? false) };
  const service = new SavedCardRemovalService(
    gateway as never,
    profiles as never,
    attempts as never,
    bookings as never,
  );
  return { service, gateway, profiles, attempts, bookings, profile };
};

describe("saved-card removal", () => {
  it("removes the Customer's own card: Bookly projection cleared first, then Stripe detach", async () => {
    const f = build({ localCard: "pm_1" });
    await expect(f.service.removeSavedCard(userId, "pm_1")).resolves.toEqual({
      removed: true,
      paymentMethodId: "pm_1",
      alreadyDetached: false,
    });
    expect(f.gateway.lookupPaymentMethodOwner).toHaveBeenCalledWith("pm_1");
    expect(f.gateway.detachPaymentMethod).toHaveBeenCalledWith("pm_1");
    expect(f.profiles.clearPaymentMethodIfCurrent.mock.invocationCallOrder[0]).toBeLessThan(
      f.gateway.detachPaymentMethod.mock.invocationCallOrder[0] ?? 0,
    );
    expect(f.profile["defaultPaymentMethodId"]).toBeUndefined();
    // Last card removed: no automatic fallback, no other money movement.
    expect(f.gateway.createAndConfirmPaymentIntent).not.toHaveBeenCalled();
    expect(f.gateway.createRefund).not.toHaveBeenCalled();
  });

  it("another Customer's or unknown card is the same 404, with no mutation", async () => {
    for (const owner of [
      { outcome: "FOUND" as const, customerId: "cus_other", isCard: true },
      { outcome: "NOT_FOUND" as const },
      { outcome: "FOUND" as const, customerId: null, isCard: true },
    ]) {
      const f = build({ localCard: "pm_mine", owner });
      await expect(f.service.removeSavedCard(userId, "pm_theirs")).rejects.toMatchObject({
        statusCode: 404,
        details: [{ code: "PAYMENT_METHOD_NOT_FOUND" }],
      });
      expect(f.gateway.detachPaymentMethod).not.toHaveBeenCalled();
      expect(f.profiles.clearPaymentMethodIfCurrent).not.toHaveBeenCalled();
      expect(f.profile["defaultPaymentMethodId"]).toBe("pm_mine");
    }
  });

  it("a card already detached at Stripe only clears Bookly's stale reference (idempotent retry)", async () => {
    const f = build({ localCard: "pm_1", owner: { outcome: "NOT_FOUND" } });
    await expect(f.service.removeSavedCard(userId, "pm_1")).resolves.toMatchObject({
      alreadyDetached: true,
    });
    expect(f.gateway.detachPaymentMethod).not.toHaveBeenCalled();
    expect(f.profile["defaultPaymentMethodId"]).toBeUndefined();
  });

  it("refuses while a payment is unsettled (incl. 3DS) or a booking relies on the card; nothing changes", async () => {
    for (const [options, reason] of [
      [{ unsettled: [true] }, "ACTIVE_PAYMENT"],
      [{ activeBooking: [true] }, "ACTIVE_BOOKING"],
    ] as const) {
      const f = build({ localCard: "pm_1", ...options });
      await expect(f.service.removeSavedCard(userId, "pm_1")).rejects.toMatchObject({
        statusCode: 409,
        details: [{ code: reason }],
      });
      expect(f.gateway.detachPaymentMethod).not.toHaveBeenCalled();
      expect(f.profile["defaultPaymentMethodId"]).toBe("pm_1");
    }
  });

  it("a payment or booking started during removal restores the card and refuses (race)", async () => {
    const f = build({ localCard: "pm_1", unsettled: [false, true] });
    await expect(f.service.removeSavedCard(userId, "pm_1")).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(f.gateway.detachPaymentMethod).not.toHaveBeenCalled();
    expect(f.profiles.restorePaymentMethodIfEmpty).toHaveBeenCalled();
    expect(f.profile).toMatchObject({ defaultPaymentMethodId: "pm_1", cardLast4: "4242" });
  });

  it("a definite Stripe rejection restores the card; it is never overwritten if a new card was saved meanwhile", async () => {
    const f = build({ localCard: "pm_1", detach: "REJECTED" });
    await expect(f.service.removeSavedCard(userId, "pm_1")).rejects.toMatchObject({
      statusCode: 502,
      details: [{ code: "PAYMENT_METHOD_REMOVAL_FAILED" }],
    });
    expect(f.profile["defaultPaymentMethodId"]).toBe("pm_1");

    const g = build({ localCard: "pm_1", detach: "REJECTED" });
    g.gateway.detachPaymentMethod.mockImplementationOnce(async () => {
      g.profile["defaultPaymentMethodId"] = "pm_new"; // Customer saved a new card concurrently
      return { outcome: "REJECTED" as const };
    });
    await expect(g.service.removeSavedCard(userId, "pm_1")).rejects.toMatchObject({
      statusCode: 502,
    });
    expect(g.profile["defaultPaymentMethodId"]).toBe("pm_new");
  });

  it("an uncertain detach is re-read from Stripe: confirmed gone succeeds, otherwise unconfirmed (retryable)", async () => {
    const confirmed = build({
      localCard: "pm_1",
      detach: "UNCERTAIN",
      recheck: { outcome: "FOUND", customerId: null, isCard: true },
    });
    await expect(confirmed.service.removeSavedCard(userId, "pm_1")).resolves.toMatchObject({
      removed: true,
    });

    const unknown = build({
      localCard: "pm_1",
      detach: "UNCERTAIN",
      recheck: { outcome: "UNCERTAIN" },
    });
    await expect(unknown.service.removeSavedCard(userId, "pm_1")).rejects.toMatchObject({
      statusCode: 503,
      details: [{ code: "PAYMENT_METHOD_REMOVAL_UNCONFIRMED" }],
    });
    // Not selectable for new payments while unconfirmed; never assumed detached or restored.
    expect(unknown.profile["defaultPaymentMethodId"]).toBeUndefined();

    // The retry: still attached to this Customer (not locally saved any more) => detach again.
    const retry = build({ localCard: undefined });
    await expect(retry.service.removeSavedCard(userId, "pm_1")).resolves.toMatchObject({
      removed: true,
    });
    expect(retry.gateway.detachPaymentMethod).toHaveBeenCalledTimes(1);
  });

  it("an uncertain ownership read changes nothing", async () => {
    const f = build({ localCard: "pm_1", owner: { outcome: "UNCERTAIN" } });
    await expect(f.service.removeSavedCard(userId, "pm_1")).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(f.profile["defaultPaymentMethodId"]).toBe("pm_1");
    expect(f.gateway.detachPaymentMethod).not.toHaveBeenCalled();
  });

  it("duplicate concurrent requests: one detaches, the other converges without a second detach", async () => {
    const f = build({ localCard: "pm_1" });
    await f.service.removeSavedCard(userId, "pm_1");
    const second = build({
      localCard: undefined,
      owner: { outcome: "FOUND", customerId: null, isCard: true },
    });
    // Second request sees Stripe already detached and no local card: 404 (nothing left to remove).
    await expect(second.service.removeSavedCard(userId, "pm_1")).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(second.gateway.detachPaymentMethod).not.toHaveBeenCalled();
  });
});

describe("Stripe outcome classification and access", () => {
  it("classifies detach errors without assuming success on uncertainty", () => {
    expect(
      classifyDetachError({ type: "StripeInvalidRequestError", code: "resource_missing" }),
    ).toBe("NOT_FOUND");
    expect(
      classifyDetachError({
        type: "StripeInvalidRequestError",
        message: "The payment method you provided is not attached to a customer",
      }),
    ).toBe("NOT_ATTACHED");
    expect(
      classifyDetachError({ type: "StripeInvalidRequestError", code: "parameter_invalid_empty" }),
    ).toBe("REJECTED");
    expect(classifyDetachError({ type: "StripeRateLimitError" })).toBe("REJECTED");
    expect(classifyDetachError({ type: "StripeConnectionError" })).toBe("UNCERTAIN");
    expect(classifyDetachError({ type: "StripeAPIError" })).toBe("UNCERTAIN");
    expect(classifyDetachError(new Error("socket hang up"))).toBe("UNCERTAIN");
  });

  it("only an active CUSTOMER session reaches the removal handler; the path id is validated", () => {
    expect(savedPaymentMethodParamsSchema.safeParse({ paymentMethodId: "pm_1Abc" }).success).toBe(
      true,
    );
    for (const bad of ["cus_123", "pm_", "pm_1;drop", "../pm_1"]) {
      expect(savedPaymentMethodParamsSchema.safeParse({ paymentMethodId: bad }).success).toBe(
        false,
      );
    }
    const router = createPaymentRoute();
    const layer = router.stack.find(
      (entry) =>
        entry.route?.path === "/payment-methods/:paymentMethodId" &&
        (entry.route as unknown as { methods: Record<string, boolean> }).methods["delete"],
    );
    expect(layer).toBeTruthy();
    const [, activeUser, roles] = (layer?.route?.stack ?? []).map((entry) => entry.handle);
    const outcome = (role: string, status = "ACTIVE") => {
      let result: unknown = "allowed";
      for (const guard of [activeUser, roles]) {
        if (result !== "allowed") break;
        guard?.(
          { auth: { userId, role, status } } as Request,
          {} as Response,
          (error?: unknown) => {
            if (error) result = error;
          },
        );
      }
      return result;
    };
    for (const role of ["STAFF", "SUPERVISOR", "BUSINESS_OWNER", "SUPER_ADMIN"]) {
      expect(outcome(role)).toMatchObject({ statusCode: 403 });
    }
    expect(outcome("CUSTOMER", "SUSPENDED")).toMatchObject({ statusCode: 403 });
    expect(outcome("CUSTOMER")).toBe("allowed");
  });
});
