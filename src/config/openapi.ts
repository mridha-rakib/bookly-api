import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registerAuthOpenApi } from "../modules/auth/auth.openapi.js";
import { livenessHealthSchema, readinessHealthSchema } from "../modules/health/health.schema.js";
import { env } from "./env.js";

extendZodWithOpenApi(z);

const successEnvelope = (dataSchema: z.ZodType) =>
  z.object({
    success: z.literal(true),
    message: z.string(),
    data: dataSchema,
  });

const errorDetailSchema = z.object({
  path: z.string().optional(),
  message: z.string(),
  code: z.string().optional(),
});

const errorEnvelopeSchema = z.object({
  success: z.literal(false),
  message: z.string(),
  errors: z.array(errorDetailSchema).optional(),
  requestId: z.string().optional(),
});

const registry = new OpenAPIRegistry();

registry.register("ErrorDetail", errorDetailSchema);
registry.register("ErrorResponse", errorEnvelopeSchema);
registry.register("LivenessHealthResponse", successEnvelope(livenessHealthSchema));
registry.register("ReadinessHealthResponse", successEnvelope(readinessHealthSchema));

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Process liveness",
  description: "Lightweight process liveness check. Does not require a database query.",
  responses: {
    200: {
      description: "The API process is live.",
      content: {
        "application/json": {
          schema: successEnvelope(livenessHealthSchema),
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: `/api/${env.API_VERSION}/health`,
  summary: "Application readiness",
  description: "Readiness check that reports MongoDB connection state.",
  responses: {
    200: {
      description: "The API is ready to serve traffic.",
      content: {
        "application/json": {
          schema: successEnvelope(readinessHealthSchema),
        },
      },
    },
    503: {
      description: "The API is live but not ready.",
      content: {
        "application/json": {
          schema: successEnvelope(readinessHealthSchema),
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/openapi.json",
  summary: "OpenAPI document",
  responses: {
    200: {
      description: "Generated OpenAPI JSON document.",
    },
    404: {
      description: "Documentation is disabled.",
      content: {
        "application/json": {
          schema: errorEnvelopeSchema,
        },
      },
    },
  },
});

registerAuthOpenApi(registry, env.API_VERSION);

export const openApiDocument: Record<string, unknown> = new OpenApiGeneratorV3(
  registry.definitions,
).generateDocument({
  openapi: "3.0.0",
  info: {
    title: env.APP_NAME,
    version: "0.1.0",
    description: "Bookly backend API foundation",
  },
  servers: [
    {
      url: "/",
      description: "Current server",
    },
  ],
}) as unknown as Record<string, unknown>;

export const createSwaggerHtml = (openApiUrl = "/openapi.json"): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${env.APP_NAME} Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "${openApiUrl}",
        dom_id: "#swagger-ui"
      });
    </script>
  </body>
</html>`;
