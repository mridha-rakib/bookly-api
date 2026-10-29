/** P4K isolated interactive harness — process-local synthetic state ONLY.
 *
 * Loaded exclusively through vitest.p4k-interactive.config.ts. Nothing here is imported by
 * src/, compiled by `pnpm build`, or copied by the production Dockerfile (src/ only).
 * Every object is in-memory and dies with the harness process.
 */

import type {
  EmailTransportSendInput,
  EmailTransportSendResult,
} from "../../src/modules/email/email.types.js";
import type { EmailTransport } from "../../src/modules/email/email-transport.js";
import { syntheticConsentHost, syntheticHostObservation } from "../helpers/consent-host-fixture.js";
import { FakePaymentGateway } from "../helpers/fake-payment-gateway.js";
import { FakeTaxGateway } from "../helpers/fake-tax-gateway.js";

export const P4K_SETUP_MARKER = Symbol.for("bookly.p4k.isolated-synthetic-setup");
export const P4K_LABEL = "ISOLATED SYNTHETIC TEST AUTHORITY — not a qualified production purchase";

/** One shared fake gateway: every `new StripePaymentGateway()` in the app returns this
 * instance, so the control console can drive the exact PaymentIntent the app created. */
export const harnessGateway = new FakePaymentGateway();
export const harnessTax = new FakeTaxGateway();

export type SimulatedAuthenticationResult = "succeeded" | "failed" | "canceled";
/** Simulated 3DS/authentication for one PaymentIntent this fake gateway created. It changes only
 * the fake provider's state; the app must still re-read it and prove persistence itself. */
export const simulateAuthentication = (
  reference: { clientSecret?: string; paymentIntentId?: string },
  result: string,
) => {
  const secret = reference.clientSecret ?? "";
  const paymentIntentId =
    reference.paymentIntentId ??
    (secret.endsWith("_secret") ? secret.slice(0, -"_secret".length) : "");
  if (
    !/^pi_fake_[0-9a-f-]{36}$/.test(paymentIntentId) ||
    !harnessGateway.createdPaymentIntentIds().includes(paymentIntentId)
  )
    throw Error("unknown synthetic PaymentIntent");
  if (!["succeeded", "failed", "canceled"].includes(result))
    throw Error("result: succeeded|failed|canceled");
  harnessGateway.setPaymentIntentStatus(paymentIntentId, result as SimulatedAuthenticationResult);
  return { paymentIntentId, status: result as SimulatedAuthenticationResult };
};

/** Provider credential prefixes that must never be present inside the harness process. */
export const PROVIDER_ENV =
  /^(STRIPE_|GOOGLE_|FACEBOOK_|APPLE_|AWS_|S3_|SENDGRID_|RESEND_|TWILIO_)/;

export type ConsentClockMode =
  | { mode: "NORMAL" }
  | { mode: "SKEW"; skewMs: number }
  | { mode: "UNAVAILABLE" };
let consentClock: ConsentClockMode = { mode: "NORMAL" };
export const readConsentClock = () => consentClock;
export const setConsentClock = (next: ConsentClockMode) => {
  if (
    next.mode === "SKEW" &&
    (!Number.isSafeInteger(next.skewMs) || Math.abs(next.skewMs) > 7 * 86400000)
  )
    throw Error("Synthetic consent clock skew must be an integer within one week");
  consentClock = next;
};

/** Synthetic host observation. NORMAL = wall clock ±1 ms (same as the approved test lane).
 * SKEW shifts the synthetic trusted bound so strict-deadline lateness can be exercised
 * without touching any host clock. UNAVAILABLE models an uncertain/unreachable authority. */
export const observeSyntheticConsentHost = async (witnessHash: string) => {
  const clock = consentClock;
  if (clock.mode === "UNAVAILABLE")
    throw Error("P4K synthetic consent clock unavailable (fail closed)");
  if (clock.mode === "NORMAL") return syntheticHostObservation(witnessHash);
  const at = Date.now() + clock.skewMs;
  return syntheticHostObservation(witnessHash, {
    earliestMs: at - 1,
    latestMs: at + 1,
    referenceTimeMs: at,
  });
};

/** Historical verification only accepts the exact synthetic identity, never any other profile. */
export const requireSyntheticVerificationProfile = (identity: {
  authorityId: string;
  hostId: string;
  configurationHash: string;
  approvedBootId: string;
}) => {
  if (
    identity.authorityId !== syntheticConsentHost.authorityId ||
    identity.hostId !== syntheticConsentHost.hostId ||
    identity.configurationHash !== syntheticConsentHost.configurationHash ||
    identity.approvedBootId !== syntheticConsentHost.approvedBootId
  )
    throw Error("P4K harness verifies only its own synthetic consent host identity");
  return syntheticConsentHost;
};

export type CapturedEmail = EmailTransportSendInput & { capturedAt: string; id: string };
export const capturedEmails: CapturedEmail[] = [];
/** Capture-only email transport. No SMTP/provider connection is ever opened. */
export class CaptureEmailTransport implements EmailTransport {
  public readonly provider = "smtp" as const;
  /** Accepts (and ignores) the provider adapters' optional client-factory argument. */
  public constructor(..._ignored: unknown[]) {}
  public isConfigured() {
    return true;
  }
  public async send(input: EmailTransportSendInput): Promise<EmailTransportSendResult> {
    const id = `p4k-mail-${capturedEmails.length + 1}`;
    capturedEmails.push({ ...input, capturedAt: new Date().toISOString(), id });
    if (capturedEmails.length > 500) capturedEmails.shift();
    return { provider: "smtp", status: "PROVIDER_ACCEPTED", providerMessageId: id };
  }
}

/** Loopback-only fetch guard for the harness process. Defence in depth, not network isolation:
 * the approved runner must still deny egress independently. */
export const installLoopbackFetchGuard = () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw Error(`P4K harness blocked non-loopback fetch to ${url.hostname}`);
    return original(input, init);
  }) as typeof fetch;
};
