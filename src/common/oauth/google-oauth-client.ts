import { type Credentials, OAuth2Client, type TokenPayload } from "google-auth-library";

export type GoogleOAuthClientConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type GoogleAuthUrlOptions = {
  scope: string[];
  /** `"online"` for flows that never call a Google API again (linking, login); `"offline"` when
   * a refresh token is needed for later API calls (Calendar sync). */
  accessType: "online" | "offline";
  prompt: string;
  state: string;
};

/**
 * Thin, feature-agnostic wrapper around `google-auth-library`'s `OAuth2Client`. It owns ONLY the
 * mechanics shared by every Google OAuth flow in this codebase — Google Calendar sync, Customer
 * account linking, and (future) Google login: constructing the client from a config triple,
 * building a consent URL, exchanging an authorization `code`, verifying an `id_token`, and
 * refreshing an access token.
 *
 * It deliberately holds NO feature policy: which scopes / prompt / access type, which redirect
 * URI, which env var decides "configured", and how a raw provider failure maps to a domain error
 * all stay in the calling feature module (see `integration.google-client.ts` /
 * `linked-account/google-oauth.client.ts`). It never reads env and never logs. Replaces the two
 * near-identical `createOAuthClient()` helpers those modules used to each define privately.
 */
export class GoogleOAuthClient {
  public constructor(private readonly config: GoogleOAuthClientConfig) {}

  /** The OAuth client id — also the expected `id_token` audience. */
  public get clientId(): string {
    return this.config.clientId;
  }

  public generateAuthUrl(options: GoogleAuthUrlOptions): string {
    return this.createClient().generateAuthUrl({
      access_type: options.accessType,
      prompt: options.prompt,
      scope: options.scope,
      state: options.state,
    });
  }

  /** Exchanges an authorization `code` for a token set. Throws the raw provider error — callers
   * map it to their own domain error, exactly as before. */
  public async exchangeCode(code: string): Promise<Credentials> {
    const { tokens } = await this.createClient().getToken(code);
    return tokens;
  }

  /** Verifies an `id_token` against Google's keys with `aud` pinned to this client id. Returns
   * the decoded payload (or `undefined`, matching `getPayload()`'s own contract). */
  public async verifyIdToken(idToken: string): Promise<TokenPayload | undefined> {
    const ticket = await this.createClient().verifyIdToken({
      idToken,
      audience: this.config.clientId,
    });
    return ticket.getPayload();
  }

  /** Exchanges a stored refresh token for a fresh access token. Google may omit a new refresh
   * token on refresh — callers keep the existing one. Throws the raw provider error. */
  public async refreshAccessToken(refreshToken: string): Promise<Credentials> {
    const client = this.createClient();
    client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await client.refreshAccessToken();
    return credentials;
  }

  private createClient(): OAuth2Client {
    return new OAuth2Client({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      redirectUri: this.config.redirectUri,
    });
  }
}
