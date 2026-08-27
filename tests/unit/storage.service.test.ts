import { beforeEach, describe, expect, it, vi } from "vitest";

const s3ClientConstructorCalls: unknown[] = [];
const sendMock = vi.fn(
  async (_command: { __command: string; input: Record<string, unknown> }) => ({}),
);
const getSignedUrlMock = vi.fn(
  async (_client: unknown, _command: unknown, _options: { expiresIn: number }) =>
    "https://presigned.example/signed",
);

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    public constructor(config: unknown) {
      s3ClientConstructorCalls.push(config);
    }
    public send = sendMock;
  }
  const makeCommand = (name: string) =>
    vi.fn(function CommandConstructor(this: { __command: string; input: unknown }, input: unknown) {
      this.__command = name;
      this.input = input;
    });

  return {
    S3Client,
    PutObjectCommand: makeCommand("PutObject"),
    DeleteObjectCommand: makeCommand("DeleteObject"),
    GetObjectCommand: makeCommand("GetObject"),
    HeadObjectCommand: makeCommand("HeadObject"),
    HeadBucketCommand: makeCommand("HeadBucket"),
    CreateBucketCommand: makeCommand("CreateBucket"),
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: getSignedUrlMock,
}));

const baseEnv = {
  STORAGE_PROVIDER: "s3" as const,
  S3_ENDPOINT: "https://hel1.your-objectstorage.com",
  S3_REGION: "hel1",
  S3_BUCKET: "bookly-cy-storage",
  S3_ACCESS_KEY_ID: "test-access-key",
  S3_SECRET_ACCESS_KEY: "test-secret-key",
  S3_FORCE_PATH_STYLE: true,
  S3_PUBLIC_BASE_URL: undefined as string | undefined,
  BUSINESS_MEDIA_SIGNED_URL_TTL_SECONDS: 900,
};

let mockedEnv = { ...baseEnv };

vi.mock("../../src/config/env.js", () => ({
  get env() {
    return mockedEnv;
  },
}));

describe("storage.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s3ClientConstructorCalls.length = 0;
    mockedEnv = { ...baseEnv };
  });

  it("builds the S3 client with the configured Hetzner endpoint/region/path-style, never logging credentials", async () => {
    const { createStorageServiceFromEnv } = await import(
      "../../src/modules/storage/storage.service.js"
    );

    const service = createStorageServiceFromEnv();

    expect(service.bucket).toBe("bookly-cy-storage");
    expect(s3ClientConstructorCalls).toHaveLength(1);
    expect(s3ClientConstructorCalls[0]).toMatchObject({
      endpoint: "https://hel1.your-objectstorage.com",
      region: "hel1",
      forcePathStyle: true,
    });
  });

  it("throws STORAGE_NOT_CONFIGURED when required S3 config is missing", async () => {
    mockedEnv = { ...baseEnv, S3_BUCKET: undefined as unknown as string };
    const { createStorageServiceFromEnv } = await import(
      "../../src/modules/storage/storage.service.js"
    );

    expect(() => createStorageServiceFromEnv()).toThrow();
  });

  it("throws STORAGE_NOT_CONFIGURED when STORAGE_PROVIDER is not s3", async () => {
    mockedEnv = { ...baseEnv, STORAGE_PROVIDER: "unset" as unknown as "s3" };
    const { createStorageServiceFromEnv } = await import(
      "../../src/modules/storage/storage.service.js"
    );

    expect(() => createStorageServiceFromEnv()).toThrow();
  });

  it("uploads and deletes against the configured bucket/key without exposing credentials", async () => {
    const { createStorageServiceFromEnv } = await import(
      "../../src/modules/storage/storage.service.js"
    );
    const service = createStorageServiceFromEnv();

    await service.putObject({
      key: "businesses/b1/media/one.png",
      body: Buffer.from("data"),
      contentType: "image/png",
      contentLength: 4,
    });
    await service.deleteObject({ key: "businesses/b1/media/one.png" });

    expect(sendMock).toHaveBeenCalledTimes(2);
    const [putCall] = sendMock.mock.calls[0] ?? [];
    const [deleteCall] = sendMock.mock.calls[1] ?? [];
    expect(putCall?.input["Bucket"]).toBe("bookly-cy-storage");
    expect(putCall?.input["Key"]).toBe("businesses/b1/media/one.png");
    expect(deleteCall?.input["Bucket"]).toBe("bookly-cy-storage");

    for (const call of sendMock.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("test-secret-key");
    }
  });

  it("returns a presigned GET URL scoped to the endpoint when no public base URL is configured", async () => {
    const { createStorageServiceFromEnv } = await import(
      "../../src/modules/storage/storage.service.js"
    );
    const service = createStorageServiceFromEnv();

    const url = await service.getObjectUrl({ key: "businesses/b1/media/one.png" });

    expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
    const [, , options] = getSignedUrlMock.mock.calls[0] ?? [];
    expect(options).toMatchObject({ expiresIn: 900 });
    expect(url).toBe("https://presigned.example/signed");
  });

  it("returns a public URL built from S3_PUBLIC_BASE_URL when configured, bypassing signing", async () => {
    mockedEnv = { ...baseEnv, S3_PUBLIC_BASE_URL: "https://cdn.example.com" };
    const { createStorageServiceFromEnv } = await import(
      "../../src/modules/storage/storage.service.js"
    );
    const service = createStorageServiceFromEnv();

    const url = await service.getObjectUrl({ key: "businesses/b1/media/one.png" });

    expect(getSignedUrlMock).not.toHaveBeenCalled();
    expect(url).toBe("https://cdn.example.com/businesses/b1/media/one.png");
  });
});
