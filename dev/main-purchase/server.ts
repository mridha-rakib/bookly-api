// biome-ignore-all lint/suspicious/noConsole: explicit development startup notice
import { authorityDirectory, loadMainConfiguration } from "./configuration.js";

const environment = loadMainConfiguration();
// The clock's canonical digest imports application schemas. Load it only AFTER configuration,
// so the application's immutable env object sees the guarded bind/lifetime too.
const { compose, DevelopmentClock } = await import("./clock.js");
const { env } = await import("../../src/config/env.js");
if (
  env.HTTP_BIND_HOST !== environment["HTTP_BIND_HOST"] ||
  env.MONGODB_URI !== environment["MONGODB_URI"] ||
  env.STRIPE_SECRET_KEY !== environment["STRIPE_SECRET_KEY"] ||
  env.STRIPE_PUBLISHABLE_KEY !== environment["STRIPE_PUBLISHABLE_KEY"]
)
  throw Error("Effective application configuration differs from guarded development configuration");
const clock = new DevelopmentClock(authorityDirectory, environment);
clock.startMonitor();
compose(clock);
process.once("exit", () => clock.close());
console.warn(
  "MAIN DEVELOPMENT PURCHASE: host-relative clock, NO qualified UTC; pinned existing development database, loopback HTTP and Stripe TEST only. Shipped production authority remains denied.",
);
// Reuse the complete main application, Mongoose connection, routes and financial writer.
await import("../../src/app/server.js");
