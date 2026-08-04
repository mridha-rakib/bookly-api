import type { ParsedQs } from "qs";

declare global {
  namespace Express {
    interface Request {
      id?: string;
      auth?: {
        userId: string;
        role: import("../../modules/user/user.types.js").UserRole;
        status: import("../../modules/user/user.types.js").UserStatus;
      };
      validated?: {
        params?: unknown;
        query?: ParsedQs | Record<string, unknown>;
        body?: unknown;
        headers?: unknown;
      };
    }
  }
}
