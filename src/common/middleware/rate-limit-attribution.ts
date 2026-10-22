import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { NextFunction, Request, RequestHandler, Response } from "express";

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

/**
 * HTTP 429 attribution: records WHICH express-rate-limit instance rejected a request, without
 * touching the limiter itself. The wrapped limiter keeps its own options, store, key, headers,
 * message and handler; this wrapper only observes whether that limiter ended the request (never
 * called `next`) with a 429, and reports once after the response has been sent. A request that
 * passed this limiter and was rejected by a later one is attributed to the later one only.
 *
 * Never recorded: client IP or limiter key, query strings, raw dynamic path values, headers,
 * cookies, tokens, bodies, or client-supplied request IDs that are not UUID-shaped.
 */
export type RateLimitRejectionEvent = {
  event: "rate_limit_rejected";
  timestamp: string;
  limiter: string;
  method: string;
  endpoint: string;
  requestId: string;
  limit: number | "unresolved";
  windowMs: number | "unresolved";
  used: number | "unresolved";
  resetTime: string | "unresolved";
  retryAfterSeconds: number | "unresolved";
  environment: string;
};

export type RateLimitRejectionReporter = (event: RateLimitRejectionEvent) => void;

export type RateLimiterAttribution = {
  /** Stable logical limiter name, e.g. "global-api", "discovery", "auth-refresh". */
  name: string;
  limit: number;
  windowMs: number;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Literal segments are kept only when they cannot carry an identifier: lowercase words joined by
// hyphens, or an API version. Anything else (ObjectIds, UUIDs, emails, tokens, slugs with digits)
// becomes ":param". Express route templates may also contribute their own ":name" placeholders.
const literalSegmentPattern = /^(?:[a-z]{1,40}(?:-[a-z]{1,40}){0,5}|v\d{1,2})$/;
const templateParamPattern = /^:[A-Za-z][A-Za-z0-9_]{0,40}$/;
const maxSegments = 12;
const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

type EndpointContext = { baseUrl: string; path: string; routePath: unknown };

/** Sanitized endpoint: Express route template when the limiter ran inside a route, else the
 * conservatively normalized mount-relative path. Never includes the query string. */
export const describeRateLimitedEndpoint = ({
  baseUrl,
  path: requestPath,
  routePath,
}: EndpointContext): string => {
  const usesTemplate = typeof routePath === "string";
  const raw = `${baseUrl}${usesTemplate ? routePath : requestPath}`;
  const segments = raw.split("?")[0]?.split("/").filter(Boolean) ?? [];
  if (segments.length > maxSegments) return "unresolved";
  const safe = segments.map((segment, index) => {
    // Template placeholders only come from the route definition, which is the trailing part.
    const fromTemplate = usesTemplate && index >= baseUrl.split("/").filter(Boolean).length;
    if (fromTemplate && templateParamPattern.test(segment)) return segment;
    return literalSegmentPattern.test(segment) ? segment : ":param";
  });
  return `/${safe.join("/")}`;
};

type RateLimitInfoLike = { limit?: unknown; used?: unknown; resetTime?: unknown };

const finiteNumber = (value: unknown): number | "unresolved" =>
  typeof value === "number" && Number.isFinite(value) ? value : "unresolved";

export const buildRateLimitRejectionEvent = (
  attribution: RateLimiterAttribution,
  request: Request,
  response: Response,
  endpoint: EndpointContext,
  now: Date = new Date(),
): RateLimitRejectionEvent => {
  const info = (request as Request & { rateLimit?: RateLimitInfoLike }).rateLimit;
  const retryAfter = response.getHeader("Retry-After");
  const retryAfterSeconds =
    typeof retryAfter === "string" && /^\d{1,7}$/.test(retryAfter)
      ? Number(retryAfter)
      : finiteNumber(retryAfter);
  const resetTime =
    info?.resetTime instanceof Date && !Number.isNaN(info.resetTime.getTime())
      ? info.resetTime.toISOString()
      : "unresolved";

  return {
    event: "rate_limit_rejected",
    timestamp: now.toISOString(),
    limiter: attribution.name,
    method: methods.has(request.method) ? request.method : "unresolved",
    endpoint: describeRateLimitedEndpoint(endpoint),
    requestId:
      typeof request.id === "string" && uuidPattern.test(request.id) ? request.id : "unresolved",
    limit: finiteNumber(info?.limit ?? attribution.limit),
    windowMs: finiteNumber(attribution.windowMs),
    used: finiteNumber(info?.used),
    resetTime,
    retryAfterSeconds,
    environment: env.NODE_ENV,
  };
};

const developmentDiagnosticFile = path.join(
  tmpdir(),
  "bookly-dev-diagnostics",
  "rate-limit-rejections.jsonl",
);
const maxDiagnosticFileBytes = 1024 * 1024;
let diagnosticWrites: Promise<void> = Promise.resolve();

/** Appends one sanitized JSON line. Serialized, size-capped (current file + one rotated `.1`),
 * and failure-silent: diagnostics must never affect request handling. */
export const appendRateLimitDiagnostic = (
  event: RateLimitRejectionEvent,
  file: string = developmentDiagnosticFile,
  maxBytes: number = maxDiagnosticFileBytes,
): Promise<void> => {
  diagnosticWrites = diagnosticWrites
    .then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const size = await stat(file).then(
        (stats) => stats.size,
        () => 0,
      );
      if (size >= maxBytes) await rename(file, `${file}.1`);
      await appendFile(file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    })
    .catch(() => undefined);
  return diagnosticWrites;
};

/** Default reporter: structured warn log (terminal), plus a project-external JSONL file in
 * development only so the evidence survives the terminal. Production/test write no file. */
export const reportRateLimitRejection: RateLimitRejectionReporter = (event) => {
  logger.warn(event, "Rate limit rejected request");
  if (env.NODE_ENV === "development") void appendRateLimitDiagnostic(event);
};

export const attributeRateLimitRejections = (
  limiter: RequestHandler,
  attribution: RateLimiterAttribution,
  report: RateLimitRejectionReporter = reportRateLimitRejection,
): RequestHandler => {
  const attributed = (request: Request, response: Response, next: NextFunction) => {
    // Captured on entry: the limiter may end the request before routing restores these.
    const endpoint: EndpointContext = {
      baseUrl: request.baseUrl,
      path: request.path,
      routePath: request.route?.path,
    };
    let passed = false;
    let reported = false;
    const onEnd = () => {
      if (passed || reported || response.statusCode !== 429) return;
      reported = true;
      try {
        report(buildRateLimitRejectionEvent(attribution, request, response, endpoint));
      } catch {
        // Attribution is best-effort; the 429 has already been sent unchanged.
      }
    };
    response.once("finish", onEnd);
    response.once("close", onEnd);
    return limiter(request, response, (error?: unknown) => {
      passed = true;
      next(error as Parameters<NextFunction>[0]);
    });
  };
  return attributed;
};
