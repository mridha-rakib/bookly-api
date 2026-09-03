/**
 * Phase 1 — Google Account Linking only. The provider list is a single-element `as const` tuple
 * so the schema enum, the model enum, and every service/repository signature all derive from one
 * source; Facebook / Apple are deliberately out of scope and are NOT added here.
 */
export const linkedAccountProviders = ["GOOGLE"] as const;

export type LinkedAccountProvider = (typeof linkedAccountProviders)[number];

/**
 * The shape returned on `GET /auth/me` as `linkedAccounts[]`. Deliberately minimal — it never
 * exposes `providerAccountId`, provider tokens, or internal ids. `linkedAt` is serialised to an
 * ISO string to match every other date on the `/auth/me` payload.
 */
export type LinkedAccountSummary = {
  provider: LinkedAccountProvider;
  email: string;
  displayName?: string;
  linkedAt: string;
};
