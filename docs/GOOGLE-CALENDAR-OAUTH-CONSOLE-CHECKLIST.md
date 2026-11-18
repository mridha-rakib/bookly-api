# Google Calendar connection: Google Cloud Console checklist (read-only)

Purpose: let any Business Owner connect **any** eligible Google account (personal Gmail or Google
Workspace) to Bookly Calendar sync. Bookly's code shows Google's account chooser
(`prompt=consent select_account`) and does not tie the account to the Bookly login email. Whether
an arbitrary account can actually authorize is decided by Google Cloud Console settings, which
only the Owner checks and changes. Never paste client secrets, tokens or keys anywhere.

| # | Check | Expected |
|---|---|---|
| 1 | Project | The OAuth client in `GOOGLE_CLIENT_ID` belongs to Bookly's intended Google Cloud project (APIs & Services → Credentials). |
| 2 | Google Calendar API | **Enabled** in that project (APIs & Services → Enabled APIs). |
| 3 | Audience / user type | **External**. "Internal" limits sign-in to one Workspace organisation, so personal Gmail accounts would be refused. |
| 4 | Publishing status | **In production** for real Owners. In **Testing**, only the listed test users can authorize, and their refresh tokens expire after 7 days. |
| 5 | Scopes on the consent screen | `openid`, `…/auth/userinfo.email`, `…/auth/calendar.events`, `…/auth/calendar.calendars.readonly`. Nothing broader. |
| 6 | Sensitive-scope verification | `calendar.events` and `calendar.calendars.readonly` are sensitive scopes. A production app needs Google's verification (privacy policy, home page, authorized domains, demo video). Until it is verified, users see the "unverified app" warning, and new-user caps apply. |
| 7 | Authorized redirect URIs | Exactly the API callback per environment, e.g. `https://<staging-api-host>/api/v1/businesses/integrations/google-calendar/callback` and `https://<production-api-host>/api/v1/businesses/integrations/google-calendar/callback`. Each must equal that environment's `GOOGLE_CALENDAR_REDIRECT_URI`, byte for byte (scheme, host, path, no trailing slash). |
| 8 | Authorized domains | The staging and production domains, plus the privacy-policy and home-page domains, are listed on the consent screen. |
| 9 | Client binding | Each environment's `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` come from the **same** OAuth client whose redirect URIs are listed in row 7. |
| 10 | Refresh tokens | Bookly requests `access_type=offline` with `prompt=consent`, so Google issues a refresh token on each connection. In Testing mode those tokens expire after 7 days; in production they last until revoked. Revocation or expiry shows "Reconnection required" in Bookly; sync never reports success after it. |
| 11 | Workspace accounts | A Workspace admin may block third-party apps or Calendar access. That account then fails at Google's consent step. This is an organisation policy, not a Bookly defect. |

**External blockers.** If the app is still in Testing, is Internal, or awaits sensitive-scope
verification, public connection is blocked by Google configuration. Record that as an external
blocker. No application change fixes it.
