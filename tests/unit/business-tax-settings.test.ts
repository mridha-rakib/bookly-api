import { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import type { BusinessRepository } from "../../src/modules/business/business.repository.js";
import type { BusinessBookingSettingsRepository } from "../../src/modules/business-booking-settings/business-booking-settings.repository.js";
import { BusinessBookingSettingsService } from "../../src/modules/business-booking-settings/business-booking-settings.service.js";
import {
  assessBusinessFeeTax,
  isBusinessTaxSetupComplete,
  updateBusinessTaxSettingsBodySchema,
} from "../../src/modules/business-booking-settings/business-tax-settings.js";
import {
  buildPaymentIntentMetadata,
  parsePaymentIntentMetadata,
} from "../../src/modules/payment/payment-intent-metadata.js";

const updatedAt = new Date("2026-11-05T00:00:00.000Z");

describe("P0.5 Business tax settings", () => {
  it("validates the Cyprus VAT position and normalizes the VAT number", () => {
    expect(
      updateBusinessTaxSettingsBodySchema.parse({
        status: "VAT_REGISTERED",
        countryCode: "CY",
        vatNumber: "cy 1234 5678 x",
      }),
    ).toEqual({ status: "VAT_REGISTERED", countryCode: "CY", vatNumber: "CY12345678X" });
    for (const body of [
      { status: "VAT_REGISTERED", countryCode: "CY" },
      { status: "VAT_REGISTERED", countryCode: "CY", vatNumber: "CY1234" },
      { status: "VAT_REGISTERED", countryCode: "GR", vatNumber: "CY12345678X" },
      { status: "VAT_EXEMPT", countryCode: "CY", vatNumber: "CY12345678X" },
      { status: "NOT_CONFIGURED", countryCode: "CY" },
    ])
      expect(updateBusinessTaxSettingsBodySchema.safeParse(body).success).toBe(false);
  });

  it("never enables fee VAT calculation and distinguishes each blocker", () => {
    expect(assessBusinessFeeTax(undefined)).toEqual({
      calculationEnabled: false,
      blocker: "BUSINESS_TAX_SETTINGS_NOT_CONFIGURED",
    });
    expect(
      assessBusinessFeeTax({
        status: "VAT_REGISTERED",
        countryCode: "CY",
        vatNumber: "CY12345678X",
        updatedAt,
      }).blocker,
    ).toBe("BUSINESS_TAX_ACCOUNT_UNAVAILABLE");
    expect(
      assessBusinessFeeTax({ status: "NOT_VAT_REGISTERED", countryCode: "CY", updatedAt }).blocker,
    ).toBe("BUSINESS_DECLARED_NO_VAT_REGISTRATION");
    expect(isBusinessTaxSetupComplete(undefined)).toBe(false);
    expect(
      isBusinessTaxSetupComplete({ status: "VAT_REGISTERED", countryCode: "CY", updatedAt }),
    ).toBe(false);
    expect(isBusinessTaxSetupComplete({ status: "VAT_EXEMPT", countryCode: "CY", updatedAt })).toBe(
      true,
    );
  });

  it("fee PaymentIntent metadata round-trips each new not-calculated reason with zero tax", () => {
    for (const reason of [
      "BUSINESS_TAX_SETTINGS_NOT_CONFIGURED",
      "BUSINESS_TAX_ACCOUNT_UNAVAILABLE",
      "BUSINESS_DECLARED_NO_VAT_REGISTRATION",
    ] as const) {
      const metadata = buildPaymentIntentMetadata({
        bookingId: String(new Types.ObjectId()),
        businessId: String(new Types.ObjectId()),
        businessClientId: String(new Types.ObjectId()),
        purpose: "NO_SHOW_FEE",
        preTaxChargeCents: 6000,
        taxCents: 0,
        chargedAmountCents: 6000,
        taxMode: "PRE_ACTIVATION",
        taxNotCalculatedReason: reason,
      });
      expect(parsePaymentIntentMetadata(metadata)).toMatchObject({
        taxStatus: "NOT_CALCULATED",
        taxNotCalculatedReason: reason,
        taxCents: 0,
        taxCollectedCents: 0,
      });
    }
  });

  it("only the owning user can read or change a Business's tax settings", async () => {
    const ownerId = new Types.ObjectId();
    const businessId = new Types.ObjectId();
    const writes: unknown[] = [];
    const service = new BusinessBookingSettingsService(
      {
        findByBusinessId: async () => null,
        upsertTaxByBusinessId: async (...args: unknown[]) => {
          writes.push(args);
          return {
            businessId,
            gapEliminationEnabled: false,
            tax: { status: "VAT_EXEMPT", countryCode: "CY", updatedAt, updatedByUserId: ownerId },
          };
        },
      } as unknown as BusinessBookingSettingsRepository,
      {
        findById: async (id: string) =>
          String(id) === String(businessId) ? { _id: businessId, ownerUserId: ownerId } : null,
      } as unknown as BusinessRepository,
    );
    const body = { status: "VAT_EXEMPT", countryCode: "CY" } as const;

    await expect(
      service.updateTaxSettings(String(new Types.ObjectId()), String(businessId), body),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.getTaxSettings(String(new Types.ObjectId()), String(businessId)),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(writes).toHaveLength(0);

    expect(await service.getTaxSettings(String(ownerId), String(businessId))).toMatchObject({
      status: "NOT_CONFIGURED",
      setupComplete: false,
      feeVatCalculationEnabled: false,
      feeVatBlocker: "BUSINESS_TAX_SETTINGS_NOT_CONFIGURED",
    });
    expect(
      await service.updateTaxSettings(String(ownerId), String(businessId), body),
    ).toMatchObject({
      status: "VAT_EXEMPT",
      vatNumber: null,
      setupComplete: true,
      feeVatCalculationEnabled: false,
      feeVatBlocker: "BUSINESS_DECLARED_NO_VAT_REGISTRATION",
    });
  });
});
