import { createOAuthNonceCookie } from "../../common/oauth/oauth-nonce.cookie.js";
import { env } from "../../config/env.js";

/**
 * Nonce cookie for the Business Owner "Continue with Facebook" flow. Distinct name from the
 * Customer Facebook cookie and the Google cookies so none clobber each other in the same browser.
 * Mechanics live in the shared {@link createOAuthNonceCookie} helper.
 */
const nonceCookie = createOAuthNonceCookie(
  `${env.AUTH_COOKIE_NAME}_oauth_nonce_facebook_professional`,
);

export const setOAuthNonceCookie = nonceCookie.set;
export const clearOAuthNonceCookie = nonceCookie.clear;
export const readOAuthNonceCookie = nonceCookie.read;
