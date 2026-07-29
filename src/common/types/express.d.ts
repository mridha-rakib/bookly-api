import type { ParsedQs } from "qs";

declare global {
  namespace Express {
    interface Request {
      id?: string;
      validated?: {
        params?: unknown;
        query?: ParsedQs | Record<string, unknown>;
        body?: unknown;
        headers?: unknown;
      };
    }
  }
}
