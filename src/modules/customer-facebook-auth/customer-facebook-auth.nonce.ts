import { createOAuthNonceCookie } from "../../common/oauth/oauth-nonce.cookie.js";
import { env } from "../../config/env.js";

/**
 * Nonce cookie for the Customer "Continue with Facebook" flow. Distinct name from the Google
 * flows' and the Professional Facebook flow's cookies so none clobber each other in the same
 * browser. Mechanics live in the shared {@link createOAuthNonceCookie} helper.
 */
const nonceCookie = createOAuthNonceCookie(`${env.AUTH_COOKIE_NAME}_oauth_nonce_facebook_customer`);

export const setOAuthNonceCookie = nonceCookie.set;
export const clearOAuthNonceCookie = nonceCookie.clear;
export const readOAuthNonceCookie = nonceCookie.read;
