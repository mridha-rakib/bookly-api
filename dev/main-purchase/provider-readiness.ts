// biome-ignore-all lint/suspicious/noConsole: sanitized read-only Stripe TEST readiness output
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { authorityDirectory, loadMainConfiguration } from "./configuration.js";
import { installationSchema, validateEnvironment } from "./guards.js";

const environment = loadMainConfiguration();
const installation = installationSchema.parse(
  JSON.parse(readFileSync(join(authorityDirectory, "installation.json"), "utf8")),
);
validateEnvironment(environment, installation);
try {
  const { getStripeClient } = await import("../../src/modules/payment/stripe-client.js");
  const endpoints = await getStripeClient().webhookEndpoints.list({ limit: 100 });
  const relevant = [
    "payment_intent.succeeded",
    "payment_intent.payment_failed",
    "payment_intent.canceled",
    "setup_intent.succeeded",
  ];
  console.info(
    JSON.stringify({
      mode: "TEST",
      endpoints: endpoints.data.map((e) => ({
        url: e.url,
        status: e.status,
        livemode: e.livemode,
        relevantEvents: relevant.filter((event) =>
          e.enabled_events.some((enabled) => enabled === "*" || enabled === event),
        ),
      })),
    }),
  );
} catch (error) {
  const code =
    error && typeof error === "object" && "type" in error ? String(error.type) : "UNAVAILABLE";
  console.info(JSON.stringify({ mode: "TEST", endpointRead: "UNAVAILABLE", errorType: code }));
  process.exitCode = 1;
}
