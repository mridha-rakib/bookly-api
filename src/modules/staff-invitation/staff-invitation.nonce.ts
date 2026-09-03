import { createOAuthNonceCookie } from "../../common/oauth/oauth-nonce.cookie.js";
import { env } from "../../config/env.js";

/**
 * Nonce cookie for the Staff/Supervisor invitation "Continue with Google" flow. Distinct name
 * from the customer / professional flows' cookies so the three never clobber each other in the
 * same browser. Mechanics live in the shared {@link createOAuthNonceCookie} helper.
 */
const nonceCookie = createOAuthNonceCookie(`${env.AUTH_COOKIE_NAME}_oauth_nonce_staff`);

export const setOAuthNonceCookie = nonceCookie.set;
export const clearOAuthNonceCookie = nonceCookie.clear;
export const readOAuthNonceCookie = nonceCookie.read;
