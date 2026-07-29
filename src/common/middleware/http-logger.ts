import { type Options, pinoHttp } from "pino-http";

import { logger } from "../../config/logger.js";

const httpLoggerOptions: Options = {
  logger,
  genReqId: (request) => request.id ?? "",
  customProps: (request) => ({
    requestId: request.id,
  }),
};

export const httpLoggerMiddleware = pinoHttp(httpLoggerOptions);
