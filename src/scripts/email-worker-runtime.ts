// No application imports: validate launch intent before the worker builds a transport or connects.
export class EmailWorkerLaunchError extends Error {}

type Environment = Readonly<Record<string, string | undefined>>;

const present = (environment: Environment, name: string): boolean =>
  Boolean(environment[name]?.trim());

// Mirrors the per-provider requirements in config/env.ts. env.ts stays authoritative; this
// only refuses to start sending on a defaulted provider or an obviously incomplete one.
const PROVIDER_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = {
  sendgrid: ["SENDGRID_API_KEY", "EMAIL_FROM"],
  resend: ["RESEND_API_KEY", "RESEND_FROM_EMAIL", "RESEND_FROM_NAME"],
  smtp: ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "EMAIL_FROM"],
};

/**
 * Explicit operator activation for the transactional email worker. Errors name the missing
 * setting, never its value.
 */
export const assertEmailWorkerLaunch = (
  environment: Environment,
  args: readonly string[],
): void => {
  if (environment["BOOKLY_EMAIL_WORKER_ENABLED"] !== "true") {
    throw new EmailWorkerLaunchError("Email worker requires explicit worker enablement");
  }
  if (!present(environment, "MONGODB_URI")) {
    throw new EmailWorkerLaunchError("Email worker requires explicit database configuration");
  }
  const provider = environment["EMAIL_PROVIDER"]?.trim() ?? "";
  const required = PROVIDER_REQUIREMENTS[provider];
  if (!required) {
    // A defaulted provider is not an operator decision to send real email.
    throw new EmailWorkerLaunchError("Email worker requires an explicit supported EMAIL_PROVIDER");
  }
  const missing = required.filter((name) => !present(environment, name));
  if (missing.length > 0) {
    throw new EmailWorkerLaunchError(
      `Email worker provider configuration is incomplete: ${missing.join(", ")}`,
    );
  }
  if (args.length > 1 || args.some((arg) => arg !== "--once")) {
    throw new EmailWorkerLaunchError("Email worker accepts only the optional --once argument");
  }
};
