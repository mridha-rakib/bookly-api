import { describe, expect, it } from "vitest";

import {
  businessDetailsBodySchema,
  professionalEntryBodySchema,
  profileBodySchema,
  visitTypeBodySchema,
} from "../../src/modules/auth/auth.schema.js";

describe("auth request schemas", () => {
  it("normalizes frontend visit type aliases to canonical backend values", () => {
    expect(
      professionalEntryBodySchema.parse({ email: "owner@example.com", visitType: "location" }),
    ).toMatchObject({ visitType: "AT_BUSINESS_LOCATION" });
    expect(visitTypeBodySchema.parse({ sessionId: "s1", visitType: "travel" })).toMatchObject({
      visitType: "TRAVEL_TO_CUSTOMER",
    });
  });

  it("accepts canonical business visit type values", () => {
    expect(
      visitTypeBodySchema.parse({
        sessionId: "s1",
        visitType: "AT_BUSINESS_LOCATION",
      }),
    ).toMatchObject({ visitType: "AT_BUSINESS_LOCATION" });
  });

  it("rejects unconfirmed customer registration fields", () => {
    expect(() =>
      profileBodySchema.parse({
        sessionId: "s1",
        firstName: "Jane",
        lastName: "Doe",
        gender: "female",
        countryCode: "+357",
        phone: "12345678",
        password: "secret1",
        address: "not confirmed",
      }),
    ).toThrow();

    expect(() =>
      profileBodySchema.parse({
        sessionId: "s1",
        firstName: "Jane",
        lastName: "Doe",
        gender: "female",
        countryCode: "+357",
        phone: "12345678",
        password: "secret1",
        dateOfBirth: "1990-01-01",
      }),
    ).toThrow();
  });

  it("requires a business phone number from one supported frontend field", () => {
    const baseInput = {
      sessionId: "s1",
      businessName: "Salon",
      ownerName: "Jane Doe",
      city: "Larnaca",
      countryCode: "+357",
      area: "Mackenzie",
      streetName: "Emrou",
      streetNumber: "14",
      briefDesc: "A short business description",
    };

    expect(() => businessDetailsBodySchema.parse(baseInput)).toThrow();

    expect(
      businessDetailsBodySchema.parse({
        ...baseInput,
        mobileNumber: "12345678",
      }),
    ).toMatchObject({ mobileNumber: "12345678" });
  });
});
