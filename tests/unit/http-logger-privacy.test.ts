import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { lines } = vi.hoisted(() => ({ lines: [] as string[] }));

// Capture actual pino-http records with an unredacted logger, so the test
// verifies the request serializer rather than a mock of the behavior.
vi.mock("../../src/config/logger.js", async () => {
  const { default: pino } = await import("pino");
  const { Writable } = await import("node:stream");
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { logger: pino({ level: "info" }, destination) };
});

import { createErrorHandler } from "../../src/common/middleware/error-handler.js";
import { httpLoggerMiddleware } from "../../src/common/middleware/http-logger.js";
import { notFoundMiddleware } from "../../src/common/middleware/not-found.js";
import { requestIdMiddleware } from "../../src/common/middleware/request-id.js";

beforeEach(() => {
  lines.length = 0;
});

const makeApp = () => {
  const app = express();
  app.use(requestIdMiddleware, httpLoggerMiddleware);
  app.get("/callback", (_req, res) => {
    res.sendStatus(200);
  });
  app.use(notFoundMiddleware);
  app.use(createErrorHandler({ isProduction: true }));
  return app;
};

describe("HTTP logging privacy", () => {
  it("retains request correlation without OAuth URLs or credential headers", async () => {
    await request(makeApp())
      .get("/callback?code=oauth-code-fixture&state=state-fixture&access_token=token-fixture")
      .set("x-request-id", "privacy-fixture-request")
      .set("authorization", "Bearer bearer-fixture")
      .set("cookie", "session=cookie-fixture")
      .set("referer", "https://example.test/?code=referer-fixture")
      .expect(200);
    const log = lines.join("");
    expect(log).toContain("privacy-fixture-request");
    expect(log).toContain('"method":"GET"');
    expect(log).toContain('"statusCode":200');
    for (const secret of [
      "oauth-code-fixture",
      "state-fixture",
      "token-fixture",
      "bearer-fixture",
      "cookie-fixture",
      "referer-fixture",
    ]) {
      expect(log).not.toContain(secret);
    }
    const records = lines.flatMap((line) =>
      line
        .trim()
        .split("\n")
        .map((item) => JSON.parse(item)),
    );
    for (const record of records.filter((item) => item.req)) {
      expect(record.req).not.toHaveProperty("url");
      expect(record.req).not.toHaveProperty("headers");
    }
  });

  it("does not copy unknown-path or query credentials into errors or logs", async () => {
    const response = await request(makeApp())
      .get("/missing/path-token-fixture?code=missing-code-fixture")
      .expect(404);
    const output = JSON.stringify(response.body) + lines.join("");
    expect(output).not.toContain("path-token-fixture");
    expect(output).not.toContain("missing-code-fixture");
    expect(response.body.message).toBe("Route GET not found");
  });
});
