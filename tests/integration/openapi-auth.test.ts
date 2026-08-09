import { describe, expect, it } from "vitest";

import { openApiDocument } from "../../src/config/openapi.js";

const requiredAuthPaths = [
  "/api/v1/auth/customer/entry",
  "/api/v1/auth/customer/login",
  "/api/v1/auth/professional/entry",
  "/api/v1/auth/professional/login",
  "/api/v1/auth/super-admin/login",
  "/api/v1/auth/refresh",
  "/api/v1/auth/logout",
  "/api/v1/auth/me",
  "/api/v1/auth/customer/register/send-email-otp",
  "/api/v1/auth/customer/register/resend-email-otp",
  "/api/v1/auth/customer/register/verify-email-otp",
  "/api/v1/auth/customer/register/profile",
  "/api/v1/auth/customer/register/send-phone-otp",
  "/api/v1/auth/customer/register/resend-phone-otp",
  "/api/v1/auth/customer/register/verify-phone-otp-complete",
  "/api/v1/auth/customer/register/progress",
  "/api/v1/auth/professional/register/visit-type",
  "/api/v1/auth/professional/register/send-email-otp",
  "/api/v1/auth/professional/register/resend-email-otp",
  "/api/v1/auth/professional/register/verify-email-otp",
  "/api/v1/auth/professional/register/profile",
  "/api/v1/auth/professional/register/send-phone-otp",
  "/api/v1/auth/professional/register/resend-phone-otp",
  "/api/v1/auth/professional/register/verify-phone-otp",
  "/api/v1/auth/professional/register/business-details",
  "/api/v1/auth/professional/register/categories",
  "/api/v1/auth/professional/register/complete",
  "/api/v1/auth/professional/register/progress",
];

describe("OpenAPI auth document", () => {
  it("generates and documents all auth paths", () => {
    expect(openApiDocument["openapi"]).toBe("3.0.0");

    for (const path of requiredAuthPaths) {
      expect(openApiDocument["paths"]).toHaveProperty(path);
    }
  });
});
