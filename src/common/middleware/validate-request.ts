import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodError, ZodType } from "zod";

import { RequestValidationError } from "../errors/validation-error.js";

type RequestPart = "params" | "query" | "body" | "headers";

export type RequestValidationSchemas = Partial<Record<RequestPart, ZodType>>;

const zodErrorToDetails = (error: ZodError) =>
  error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));

export const validateRequest =
  (schemas: RequestValidationSchemas): RequestHandler =>
  (request: Request, _response: Response, next: NextFunction): void => {
    try {
      const validated: NonNullable<Request["validated"]> = {};

      for (const key of Object.keys(schemas) as RequestPart[]) {
        const schema = schemas[key];

        if (!schema) {
          continue;
        }

        const result = schema.safeParse(request[key]);

        if (!result.success) {
          throw new RequestValidationError(zodErrorToDetails(result.error));
        }

        validated[key] = result.data;
      }

      request.validated = validated;
      next();
    } catch (error) {
      next(error);
    }
  };
