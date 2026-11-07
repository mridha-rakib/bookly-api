import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

/** Bundle existing application components without Next or operational environment loading.
 * Only decorative header/images/notification bell are substituted. API transport and hooks are real. */
export async function buildManualBookingBrowser(): Promise<string> {
  const client = resolve(process.cwd(), "../client");
  const artifacts = resolve(client, "tests/visual");
  const require = createRequire(
    realpathSync(resolve(process.cwd(), "node_modules/tsx/package.json")),
  );
  const { build } = require("esbuild");
  const output = await build({
    absWorkingDir: client,
    entryPoints: [resolve(artifacts, "manual-booking.tsx")],
    nodePaths: [resolve(client, "node_modules")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    alias: {
      "@": resolve(client, "src"),
      "next/image": resolve(artifacts, "manual-decoration.tsx"),
      "@/components/dashboard/DashboardHeader": resolve(artifacts, "manual-decoration.tsx"),
      "@/components/notifications/NotificationBell": resolve(artifacts, "manual-decoration.tsx"),
    },
    define: {
      "process.env.NEXT_PUBLIC_API_BASE_URL": JSON.stringify("/api"),
      "process.env.NODE_ENV": JSON.stringify("test"),
    },
  });
  return output.outputFiles[0].text;
}

export function manualBookingBrowserHtml(
  businessId: string,
  token: string,
  travel = false,
): string {
  // Only synthetic sid-bound local-test credentials; never persisted to an artifact.
  return `<html><body><div id="root"></div><script>
    window.__manualFixture=${JSON.stringify({ businessId, token, visitType: travel ? "TRAVEL_TO_CUSTOMER" : "AT_BUSINESS_LOCATION" })};
    const OriginalDate=Date; globalThis.Date=class extends OriginalDate {
      constructor(...args){super(...(args.length?args:['2030-08-19T08:00:00Z']));}
      static now(){return new OriginalDate('2030-08-19T08:00:00Z').getTime();}
    };
    </script><script type="module" src="/manual-fixture.js"></script></body></html>`;
}
