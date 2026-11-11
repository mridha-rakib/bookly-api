import { Router } from "express";
import { sendSuccess } from "../../common/http/responses.js";
import { isCustomerAppleAuthConfigured } from "../customer-apple-auth/customer-apple-auth.client.js";
import { isAppleAccountLinkConfigured } from "../linked-account/apple-oauth.client.js";
import { isProfessionalAppleAuthConfigured } from "../professional-apple-auth/professional-apple-auth.client.js";

/** Public, non-sensitive capabilities. Never expose credentials or create a session. */
export const createAuthProviderRoute = (): Router => {
  const router = Router();
  router.get("/providers", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    sendSuccess(response, 200, "Authentication provider availability", {
      apple: {
        customer: isCustomerAppleAuthConfigured(),
        professional: isProfessionalAppleAuthConfigured(),
        linking: isAppleAccountLinkConfigured(),
      },
    });
  });
  return router;
};
