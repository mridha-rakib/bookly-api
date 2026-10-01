import { Types } from "mongoose";
import { beforeEach, describe, expect, it } from "vitest";

import type { CustomerPaymentProfileRepository } from "../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../src/modules/payment/payment.service.js";
import type { PaymentGateway } from "../../src/modules/payment/payment.types.js";
import type { UserRepository } from "../../src/modules/user/user.repository.js";

const makeMockUserRepository = () =>
  ({
    findById: async () => ({ _id: new Types.ObjectId(), normalizedEmail: "a@b.com" }),
    findProfileByUserId: async () => ({ firstName: "Jane", lastName: "Doe" }),
  }) as unknown as UserRepository;

const makeMockProfileRepository = (overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    findByUserId: async () => null,
    createIfMissing: async (userId: unknown, stripeCustomerId: string) => ({
      userId,
      stripeCustomerId,
    }),
    replaceStaleStripeCustomer: async () => null,
    savePaymentMethod: async () => null,
    findByStripeCustomerId: async () => null,
    ...overrides,
  }) as unknown as CustomerPaymentProfileRepository;

describe("PaymentService", () => {
  let gatewayCalls: string[];
  let gateway: PaymentGateway;

  beforeEach(() => {
    gatewayCalls = [];
    gateway = {
      getOrCreateCustomer: async (input) => {
        gatewayCalls.push("getOrCreateCustomer");
        return { stripeCustomerId: input.existingStripeCustomerId ?? "cus_test_1" };
      },
      createSetupIntent: async () => {
        gatewayCalls.push("createSetupIntent");
        return { setupIntentId: "seti_1", clientSecret: "seti_1_secret" };
      },
      retrieveSetupIntent: async () => ({ status: "succeeded", paymentMethodId: "pm_1" }),
      getPaymentMethodSummary: async () => ({
        paymentMethodId: "pm_1",
        brand: "visa",
        last4: "4242",
        expMonth: 12,
        expYear: 2030,
      }),
      setDefaultPaymentMethod: async () => {
        gatewayCalls.push("setDefaultPaymentMethod");
      },
      createAndConfirmPaymentIntent: async () => ({ paymentIntentId: "pi_1", status: "succeeded" }),
      createRefund: async () => ({ refundId: "re_1", status: "succeeded" }),
      retrieveBalanceTransactionFee: async () => null,
      retrieveProcessingFeeForPaymentIntent: async () => null,
      constructWebhookEvent: () => {
        throw new Error("not used");
      },
    };
  });

  it("ensureStripeCustomer verifies and reuses an existing Stripe Customer", async () => {
    const profileRepository = makeMockProfileRepository({
      findByUserId: async () => ({ userId: "u1", stripeCustomerId: "cus_existing" }),
    });
    const service = new PaymentService(gateway, profileRepository, makeMockUserRepository());

    const result = await service.ensureStripeCustomer("u1");
    expect(result.stripeCustomerId).toBe("cus_existing");
    expect(gatewayCalls).toContain("getOrCreateCustomer");
  });

  it("ensureStripeCustomer creates a new Stripe Customer and persists the profile for a first-time Customer", async () => {
    const profileRepository = makeMockProfileRepository();
    const service = new PaymentService(gateway, profileRepository, makeMockUserRepository());

    const result = await service.ensureStripeCustomer("u1");
    expect(result.stripeCustomerId).toBe("cus_test_1");
    expect(gatewayCalls).toContain("getOrCreateCustomer");
  });

  it("repairs a Stripe Customer confirmed missing by the gateway and clears its obsolete saved card", async () => {
    const repairCalls: Array<Record<string, unknown>> = [];
    let setupIntentCustomerId: string | undefined;
    const profileRepository = makeMockProfileRepository({
      findByUserId: async () => ({ userId: "u1", stripeCustomerId: "cus_stale" }),
      replaceStaleStripeCustomer: async (input: Record<string, unknown>) => {
        repairCalls.push(input);
        return { userId: "u1", stripeCustomerId: "cus_replacement" };
      },
    });
    gateway.getOrCreateCustomer = async () => ({
      stripeCustomerId: "cus_replacement",
      replacedStaleCustomer: true,
    });
    gateway.createSetupIntent = async ({ stripeCustomerId }) => {
      setupIntentCustomerId = stripeCustomerId;
      return { setupIntentId: "seti_repaired", clientSecret: "seti_repaired_secret" };
    };
    const service = new PaymentService(gateway, profileRepository, makeMockUserRepository());

    const result = await service.createSetupIntent("u1");

    expect(result.setupIntentId).toBe("seti_repaired");
    expect(setupIntentCustomerId).toBe("cus_replacement");
    expect(repairCalls).toEqual([
      {
        userId: "u1",
        staleStripeCustomerId: "cus_stale",
        replacementStripeCustomerId: "cus_replacement",
      },
    ]);
  });

  it("promotes a successfully confirmed replacement card only after Stripe reports success", async () => {
    const savedMethods: Array<Record<string, unknown>> = [];
    const defaultMethods: Array<Record<string, unknown>> = [];
    const profileRepository = makeMockProfileRepository({
      findByUserId: async () => ({ userId: "u1", stripeCustomerId: "cus_existing" }),
      savePaymentMethod: async (input: Record<string, unknown>) => {
        savedMethods.push(input);
        return null;
      },
    });
    gateway.setDefaultPaymentMethod = async (input) => {
      defaultMethods.push(input);
    };
    const service = new PaymentService(gateway, profileRepository, makeMockUserRepository());

    const summary = await service.confirmSavedPaymentMethod("u1", "seti_succeeded");

    expect(summary.paymentMethodId).toBe("pm_1");
    expect(defaultMethods).toEqual([{ stripeCustomerId: "cus_existing", paymentMethodId: "pm_1" }]);
    expect(savedMethods).toHaveLength(1);
    expect(savedMethods[0]).toMatchObject({ userId: "u1", defaultPaymentMethodId: "pm_1" });
  });

  it("getSavedCardStatus reports hasSavedCard:false when no default payment method is on file", async () => {
    const profileRepository = makeMockProfileRepository({
      findByUserId: async () => ({ userId: "u1", stripeCustomerId: "cus_1" }),
    });
    const service = new PaymentService(gateway, profileRepository, makeMockUserRepository());

    const status = await service.getSavedCardStatus("u1");
    expect(status.hasSavedCard).toBe(false);
  });

  it("getSavedCardStatus reports the saved card's safe display metadata", async () => {
    const profileRepository = makeMockProfileRepository({
      findByUserId: async () => ({
        userId: "u1",
        stripeCustomerId: "cus_1",
        defaultPaymentMethodId: "pm_1",
        cardBrand: "visa",
        cardLast4: "4242",
        cardExpMonth: 12,
        cardExpYear: 2030,
      }),
    });
    const service = new PaymentService(gateway, profileRepository, makeMockUserRepository());

    const status = await service.getSavedCardStatus("u1");
    expect(status.hasSavedCard).toBe(true);
    expect(status.card).toEqual({ brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 });
  });

  it("chargeBookingDeposit throws PAYMENT_METHOD_REQUIRED when no card is saved", async () => {
    const profileRepository = makeMockProfileRepository({ findByUserId: async () => null });
    const service = new PaymentService(gateway, profileRepository, makeMockUserRepository());

    await expect(
      service.chargeBookingDeposit({
        userId: "u1",
        amountCents: 2000,
        idempotencyKey: "key-1",
        metadata: {},
      }),
    ).rejects.toMatchObject({ statusCode: 402 });
  });

  it("chargeOffSession throws PAYMENT_METHOD_REQUIRED when no card is saved", async () => {
    const profileRepository = makeMockProfileRepository({ findByUserId: async () => null });
    const service = new PaymentService(gateway, profileRepository, makeMockUserRepository());

    await expect(
      service.chargeOffSession({
        userId: "u1",
        amountCents: 2000,
        idempotencyKey: "key-1",
        metadata: {},
      }),
    ).rejects.toMatchObject({ statusCode: 402 });
  });

  it("confirmSavedPaymentMethod rejects a SetupIntent that is not actually succeeded server-side", async () => {
    const profileRepository = makeMockProfileRepository();
    gateway.retrieveSetupIntent = async () => ({ status: "requires_action" });
    const service = new PaymentService(gateway, profileRepository, makeMockUserRepository());

    await expect(service.confirmSavedPaymentMethod("u1", "seti_bad")).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
