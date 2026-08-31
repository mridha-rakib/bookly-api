import { env } from "../../config/env.js";

/**
 * Canonical builder for links into the customer/business web app (Phase G). `FRONTEND_BASE_URL`
 * is already trailing-slash-stripped by the env schema; this defends again and guarantees no
 * `http://host//privacy`.
 */
export const buildFrontendUrl = (path = "/"): string => {
  const base = env.FRONTEND_BASE_URL.replace(/\/+$/, "");
  if (!path || path === "/") {
    return base;
  }
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix.replace(/\/{2,}/g, "/")}`;
};

export const FRONTEND_ROUTES = {
  privacy: "/privacy",
  termsOfUse: "/terms-of-use",
} as const;
