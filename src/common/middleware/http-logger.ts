import { type Options, pinoHttp } from "pino-http";

import { logger } from "../../config/logger.js";

const httpLoggerOptions: Options = {
  logger,
  // OAuth callbacks carry credentials in URLs. Log only request metadata;
  // never serialize URLs, queries, bodies or caller-supplied headers.
  serializers: {
    req: (request) => ({
      id: request.id,
      method: request.method,
      remoteAddress: request.remoteAddress,
      remotePort: request.remotePort,
    }),
  },
  genReqId: (request) => request.id ?? "",
  customProps: (request) => ({
    requestId: request.id,
  }),
};

export const httpLoggerMiddleware = pinoHttp(httpLoggerOptions);
