import { env } from "../../config/env.js";
import { PACKAGE_CONSENT_STRICT_LIFETIME_MS } from "./package-consent-commit-deadline.js";

/** Consent HTTP composition inputs. `enabled` is the existing route seam; no env flag sets it. */
export type PackageConsentHttpActivation = Readonly<{ enabled?: boolean; lifetimeMs?: number }>;

/** Shipped composition root value: Consent HTTP is NOT activated. Both the mounted consent
 * route (its default options) and catalogue checkout availability read this same value, so a
 * partial rollout (qualified host + batch authority without Consent HTTP) cannot advertise a
 * checkout the route would refuse. Changing it is part of the coordinated activation release,
 * never a runtime toggle. Isolated engineering tests may substitute this module. */
export const shippedPackageConsentHttpActivation: PackageConsentHttpActivation = Object.freeze({});

export type PackageConsentHttpReadiness =
  | { state: "DISABLED" }
  | { state: "NOT_CONFIGURED" }
  | { state: "LIFETIME_UNAPPROVED" }
  | { state: "READY"; lifetimeMs: number };

/** Pure, side-effect free: the exact gate the consent route applies (minus per-request origin). */
export function readPackageConsentHttpReadiness(
  activation: PackageConsentHttpActivation,
): PackageConsentHttpReadiness {
  if (activation.enabled !== true) return { state: "DISABLED" };
  const lifetimeMs = activation.lifetimeMs ?? env.PACKAGE_CONSENT_QUOTE_LIFETIME_MS;
  if (!lifetimeMs) return { state: "NOT_CONFIGURED" };
  // Explicit alternate lifetimes remain only the existing isolated characterization seam.
  // No configured production lifetime can silently change the approved 30-minute rule.
  if (activation.lifetimeMs === undefined && lifetimeMs !== PACKAGE_CONSENT_STRICT_LIFETIME_MS)
    return { state: "LIFETIME_UNAPPROVED" };
  return { state: "READY", lifetimeMs };
}
