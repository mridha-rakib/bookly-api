import { createOAuthNonceCookie } from "../../common/oauth/oauth-nonce.cookie.js";
import { env } from "../../config/env.js";

/**
 * Nonce cookie for the Business Owner "Continue with Google" flow. Distinct name from the
 * Customer flow's cookie so the two never clobber each other in the same browser. Mechanics live
 * in the shared {@link createOAuthNonceCookie} helper.
 */
const nonceCookie = createOAuthNonceCookie(`${env.AUTH_COOKIE_NAME}_oauth_nonce_professional`);

export const setOAuthNonceCookie = nonceCookie.set;
export const clearOAuthNonceCookie = nonceCookie.clear;
export const readOAuthNonceCookie = nonceCookie.read;
