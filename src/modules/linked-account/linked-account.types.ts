/**
 * Linked-account providers. A single `as const` tuple so the schema enum, the model enum, and
 * every service/repository signature all derive from one source. Google + Facebook + Apple are
 * all supported both as Settings links and as "Continue with <provider>" login/signup.
 */
export const linkedAccountProviders = ["GOOGLE", "FACEBOOK", "APPLE"] as const;

export type LinkedAccountProvider = (typeof linkedAccountProviders)[number];

/**
 * Human-facing provider name used only in error copy (see LinkedAccountError). Kept separate from
 * the stored enum so the persisted value stays the upper-case token. `satisfies Record<…>` forces
 * a label for every provider at compile time.
 */
export const linkedAccountProviderLabels = {
  GOOGLE: "Google",
  FACEBOOK: "Facebook",
  APPLE: "Apple",
} as const satisfies Record<LinkedAccountProvider, string>;

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
