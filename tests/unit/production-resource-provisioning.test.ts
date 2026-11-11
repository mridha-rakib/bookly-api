import { afterEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({
  env: {
    NODE_ENV: "production",
    MONGODB_URI: "mongodb://not-connected.test/schema-fixture",
    MONGODB_DNS_SERVERS: [] as string[],
  },
  send: vi.fn(),
}));
vi.mock("../../src/config/env.js", () => ({ env: fx.env }));
vi.mock("../../src/config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@aws-sdk/client-s3", async (original) => ({
  ...(await original<object>()),
  S3Client: class {
    send = fx.send;
  },
}));

import { CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import mongoose from "mongoose";
import { DatabaseManager } from "../../src/database/database-manager.js";
import { S3CompatibleStorageService } from "../../src/modules/storage/storage.service.js";

afterEach(() => {
  vi.restoreAllMocks();
  fx.send.mockReset();
  fx.env.NODE_ENV = "production";
});
const storage = () =>
  new S3CompatibleStorageService({
    endpoint: "https://storage.example.test",
    region: "hel1",
    bucket: "synthetic-bucket",
    accessKeyId: "synthetic-id",
    secretAccessKey: "synthetic-secret",
    forcePathStyle: true,
    signedUrlTtlSeconds: 60,
  });
describe("production startup resource guards", () => {
  it("disables implicit collection and index creation on the real database connection contract", async () => {
    const connect = vi.spyOn(mongoose, "connect").mockResolvedValue(mongoose);
    await new DatabaseManager().connect();
    expect(connect).toHaveBeenCalledWith(
      fx.env.MONGODB_URI,
      expect.objectContaining({ autoCreate: false, autoIndex: false }),
    );
  });
  it.each([403, 404, 500])(
    "never falls back to CreateBucket on production HEAD failure %s",
    async (status) => {
      fx.send.mockRejectedValue(
        Object.assign(new Error("synthetic HEAD failure"), {
          $metadata: { httpStatusCode: status },
        }),
      );
      await expect(storage().ensureBucket()).rejects.toMatchObject({ statusCode: 503 });
      expect(fx.send).toHaveBeenCalledTimes(1);
      expect(fx.send.mock.calls[0]?.[0]).toBeInstanceOf(HeadBucketCommand);
    },
  );
  it("uses an existing accessible production bucket without mutation", async () => {
    fx.send.mockResolvedValue({});
    await storage().ensureBucket();
    expect(fx.send).toHaveBeenCalledTimes(1);
  });
  it("preserves local-development bucket provisioning", async () => {
    fx.env.NODE_ENV = "development";
    fx.send.mockRejectedValueOnce(new Error("synthetic missing bucket")).mockResolvedValueOnce({});
    await storage().ensureBucket();
    expect(fx.send.mock.calls[1]?.[0]).toBeInstanceOf(CreateBucketCommand);
  });
});
