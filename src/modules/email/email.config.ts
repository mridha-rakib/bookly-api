import { buildFrontendUrl, FRONTEND_ROUTES } from "./email.links.js";

/**
 * Centralised public-facing email constants (Phase H / Phase R). The literal
 * `support@bookly.cy` and the footer link set live ONLY here — templates import them, never
 * re-type them. `admin@bookly.cy` is deliberately absent: it is an internal recipient only
 * (Stage D) and must never appear in a customer-facing footer.
 */
export const SUPPORT_EMAIL = "support@bookly.cy" as const;
export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}` as const;

/**
 * INTERNAL-ONLY notification recipients (Stage D — new business registration). `ADMIN_EMAIL` is
 * NEVER referenced by {@link getEmailFooterLinks} or any customer-facing template; it exists
 * solely for operational internal notifications. `support@bookly.cy` doubles as an internal
 * recipient here AND the public support address — that is intentional and safe.
 */
export const ADMIN_EMAIL = "admin@bookly.cy" as const;
export const INTERNAL_NOTIFICATION_RECIPIENTS = [ADMIN_EMAIL, SUPPORT_EMAIL] as const;

export const BOOKLY_BRAND = {
  name: "Bookly",
  wordmarkName: "Bookly.cy",
  /** Cyan pulled from the supplied Bookly icon. */
  cyan: "#06B6D4",
  ink: "#0F172A",
  slate: "#475569",
  mutedText: "#8A94A6",
  border: "#E6E9EF",
  pageBackground: "#F4F6F9",
  cardBackground: "#FFFFFF",
} as const;

export const EMAIL_CONTENT_WIDTH_PX = 600;

export const EMAIL_FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export type EmailFooterLink = { label: string; href: string };

/** Exactly the three useful navigation items every branded footer must carry (Phase K). */
export const getEmailFooterLinks = (): EmailFooterLink[] => [
  { label: "Contact Us", href: SUPPORT_MAILTO },
  { label: "Privacy Policy", href: buildFrontendUrl(FRONTEND_ROUTES.privacy) },
  { label: "Terms and Conditions", href: buildFrontendUrl(FRONTEND_ROUTES.termsOfUse) },
];

export const EMAIL_AUTOMATED_NOTICE = "This is an automated transactional email." as const;
export const EMAIL_COPYRIGHT = `© ${BOOKLY_BRAND.wordmarkName}` as const;
