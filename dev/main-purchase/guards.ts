import { createHash } from "node:crypto";
import { z } from "zod";

export const CONTRACT = "bookly-main-development-host-clock-v1";
export const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const installationSchema = z
  .object({
    contract: z.literal(CONTRACT),
    installationId: z.uuid(),
    developmentDataApproved: z.literal(true),
    databaseFingerprint: hash,
    stripeSecretFingerprint: hash,
    stripePublishableFingerprint: hash,
  })
  .strict();
export type Installation = z.infer<typeof installationSchema>;
type Environment = Record<string, string | undefined>;
const refuse = (): never => {
  throw Error("Main development purchase environment does not match its approved installation");
};
export function loopbackOrigin(input: string | undefined): string {
  try {
    const u = new URL(input ?? "");
    if (
      u.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
      u.username ||
      u.password ||
      u.pathname !== "/" ||
      u.search ||
      u.hash
    )
      return refuse();
    return u.origin;
  } catch {
    return refuse();
  }
}
export function validateEnvironment(e: Environment, installation?: Installation) {
  if (
    e["NODE_ENV"] !== "development" ||
    e["BOOKLY_MAIN_PURCHASE_CONTRACT"] !== CONTRACT ||
    e["BOOKLY_LOCAL_ACCEPTANCE_AUTHORITY_DIR"] ||
    e["BOOKLY_LOCAL_ACCEPTANCE"] ||
    !["127.0.0.1", "::1"].includes(e["HTTP_BIND_HOST"] ?? "") ||
    !/^(sk|rk)_test_\S+$/.test(e["STRIPE_SECRET_KEY"] ?? "") ||
    !/^pk_test_\S+$/.test(e["STRIPE_PUBLISHABLE_KEY"] ?? "") ||
    !/^whsec_\S+$/.test(e["STRIPE_WEBHOOK_SECRET"] ?? "") ||
    !/^mongodb(?:\+srv)?:\/\//.test(e["MONGODB_URI"] ?? "") ||
    e["PACKAGE_CONSENT_QUOTE_LIFETIME_MS"] !== "1800000"
  )
    return refuse();
  const port = Number(e["PORT"]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return refuse();
  const frontend = loopbackOrigin(e["FRONTEND_BASE_URL"]);
  const origins = (e["CORS_ORIGINS"] ?? "").split(",").map((s) => loopbackOrigin(s.trim()));
  if (!origins.includes(frontend)) return refuse();
  if (e["PUBLIC_API_BASE_URL"]) {
    const api = new URL(e["PUBLIC_API_BASE_URL"]);
    loopbackOrigin(api.origin);
    if (
      Number(api.port || "80") !== port ||
      api.pathname !== "/api/v1" ||
      api.search ||
      api.hash ||
      api.username ||
      api.password
    )
      return refuse();
  }
  if (
    installation &&
    (installation.databaseFingerprint !== fingerprint(e["MONGODB_URI"] ?? "") ||
      installation.stripeSecretFingerprint !== fingerprint(e["STRIPE_SECRET_KEY"] ?? "") ||
      installation.stripePublishableFingerprint !== fingerprint(e["STRIPE_PUBLISHABLE_KEY"] ?? ""))
  )
    return refuse();
  return { frontend, origins, port };
}
