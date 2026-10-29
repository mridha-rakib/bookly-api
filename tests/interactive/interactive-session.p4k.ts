/** Long-running manual session: real API + synthetic authorities + token-protected console.
 * Selected only with BOOKLY_P4K_INTERACTIVE=1. Stops on SIGINT/SIGTERM or after 8 hours.
 *
 * With BOOKLY_P4K_CLIENT_ROOT and BOOKLY_TEST_BROWSER also set, it starts the unmodified Next
 * Client against this API and opens a VISIBLE isolated Chrome window (fresh profile, loopback
 * only, simulated Stripe.js with an in-page 3DS challenge). Use that window for the journey; an
 * ordinary browser has no simulated Stripe.js and must not be pointed at this Client.
 * See dev/local/README.md (P4K section).
 */
import { it } from "vitest";
import { openP4kBrowser, type P4kPage } from "./p4k-browser.js";
import { type P4kClient, startP4kClient } from "./p4k-client.js";
import { startP4kHarness } from "./p4k-harness.js";
import { P4K_LABEL, simulateAuthentication } from "./p4k-harness-state.js";

const enabled = process.env["BOOKLY_P4K_INTERACTIVE"] === "1";
const clientRoot = process.env["BOOKLY_P4K_CLIENT_ROOT"];
const browser = process.env["BOOKLY_TEST_BROWSER"];
const maxMs = 8 * 3600000;

it.skipIf(!enabled)(
  "P4K interactive isolated First-Class Package session",
  async () => {
    const harness = await startP4kHarness();
    let client: P4kClient | undefined, page: P4kPage | undefined;
    try {
      const v = harness.seed.venue,
        t = harness.seed.travel;
      const consent = (businessId: unknown, packageId: unknown) =>
        `${harness.uiOrigin}/customer/package-consent/${businessId}/${packageId}`;
      if (clientRoot && browser) {
        client = await startP4kClient({
          clientRoot,
          apiOrigin: harness.apiOrigin,
          uiOrigin: harness.uiOrigin,
        });
        page = await openP4kBrowser({
          headed: true,
          authenticate: (clientSecret, result) => simulateAuthentication({ clientSecret }, result),
        });
        await page.goto(`${harness.uiOrigin}/venue?id=${v.id}`);
      }
      process.stdout.write(
        `\n${P4K_LABEL}\n${JSON.stringify(
          {
            api: `${harness.apiOrigin}/api/v1`,
            ui: harness.uiOrigin,
            database: harness.database,
            // The console URL carries the per-session token in its fragment. Do not share it.
            console: harness.consoleUrl,
            browser: page
              ? "Visible isolated Chrome window opened at the synthetic venue page; use only that window."
              : "Not started (set BOOKLY_P4K_CLIENT_ROOT and BOOKLY_TEST_BROWSER for the in-browser journey).",
            password: harness.seed.password,
            accounts: harness.seed.accounts,
            startHere: {
              venuePage: `${harness.uiOrigin}/venue?id=${v.id}`,
              venueFinite6: consent(v.id, v.packages.finite6._id),
              venueFinite12: consent(v.id, v.packages.finite12._id),
              venueForever: consent(v.id, v.packages.forever._id),
              atHomeFinite6: consent(t.id, t.packages.finite6._id),
              ownedPackages: `${harness.uiOrigin}/customer/bookings?view=packages`,
              ownerDashboard: `${harness.uiOrigin}/business-dashboard`,
            },
          },
          null,
          2,
        )}\nPress Ctrl+C to stop. Data is discarded on stop.\n`,
      );
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        process.once("SIGINT", done);
        process.once("SIGTERM", done);
        setTimeout(done, maxMs - 60000).unref();
      });
    } finally {
      page?.close();
      client?.stop();
      await harness.stop();
    }
  },
  maxMs,
);
