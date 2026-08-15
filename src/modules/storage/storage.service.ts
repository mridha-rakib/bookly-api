import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { env } from "../../config/env.js";
import { StorageError } from "./storage.errors.js";

export type PutObjectInput = {
  key: string;
  body: Buffer;
  contentType: string;
  contentLength: number;
};

export type ObjectKeyInput = {
  key: string;
};

export interface StorageService {
  ensureBucket(): Promise<void>;
  putObject(input: PutObjectInput): Promise<void>;
  deleteObject(input: ObjectKeyInput): Promise<void>;
  getObjectUrl(input: ObjectKeyInput): Promise<string>;
  objectExists(input: ObjectKeyInput): Promise<boolean>;
  readonly bucket: string;
}

type S3CompatibleStorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  publicBaseUrl?: string | undefined;
  signedUrlTtlSeconds: number;
};

export class S3CompatibleStorageService implements StorageService {
  private readonly client: S3Client;

  public readonly bucket: string;

  public constructor(private readonly config: S3CompatibleStorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  public async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      } catch (createError) {
        throw new StorageError("STORAGE_OPERATION_FAILED", 503, undefined, createError);
      }

      if (error instanceof Error) {
        return;
      }
    }
  }

  public async putObject(input: PutObjectInput): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          ContentLength: input.contentLength,
        }),
      );
    } catch (error) {
      throw new StorageError("STORAGE_OPERATION_FAILED", 503, undefined, error);
    }
  }

  public async deleteObject(input: ObjectKeyInput): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: input.key }));
    } catch (error) {
      throw new StorageError("STORAGE_OPERATION_FAILED", 503, undefined, error);
    }
  }

  public async getObjectUrl(input: ObjectKeyInput): Promise<string> {
    if (this.config.publicBaseUrl) {
      return `${this.config.publicBaseUrl.replace(/\/+$/, "")}/${encodeURI(input.key)}`;
    }

    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: input.key }),
        { expiresIn: this.config.signedUrlTtlSeconds },
      );
    } catch (error) {
      throw new StorageError("STORAGE_OPERATION_FAILED", 503, undefined, error);
    }
  }

  public async objectExists(input: ObjectKeyInput): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: input.key }));
      return true;
    } catch {
      return false;
    }
  }
}

const requiredStorageEnv = (): S3CompatibleStorageConfig => {
  const missing = [
    ["S3_ENDPOINT", env.S3_ENDPOINT],
    ["S3_BUCKET", env.S3_BUCKET],
    ["S3_ACCESS_KEY_ID", env.S3_ACCESS_KEY_ID],
    ["S3_SECRET_ACCESS_KEY", env.S3_SECRET_ACCESS_KEY],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new StorageError("STORAGE_NOT_CONFIGURED", 503, [
      {
        message: `Missing storage configuration: ${missing.join(", ")}`,
        code: "STORAGE_NOT_CONFIGURED",
      },
    ]);
  }

  return {
    endpoint: env.S3_ENDPOINT ?? "",
    region: env.S3_REGION,
    bucket: env.S3_BUCKET ?? "",
    accessKeyId: env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "",
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    publicBaseUrl: env.S3_PUBLIC_BASE_URL,
    signedUrlTtlSeconds: env.BUSINESS_MEDIA_SIGNED_URL_TTL_SECONDS,
  };
};

export const createStorageServiceFromEnv = (): StorageService => {
  if (env.STORAGE_PROVIDER !== "s3") {
    throw new StorageError("STORAGE_NOT_CONFIGURED", 503);
  }

  return new S3CompatibleStorageService(requiredStorageEnv());
};

export class DeferredStorageService implements StorageService {
  private storageService: StorageService | undefined;

  public get bucket(): string {
    return this.getStorageService().bucket;
  }

  public async ensureBucket(): Promise<void> {
    await this.getStorageService().ensureBucket();
  }

  public async putObject(input: PutObjectInput): Promise<void> {
    await this.getStorageService().putObject(input);
  }

  public async deleteObject(input: ObjectKeyInput): Promise<void> {
    await this.getStorageService().deleteObject(input);
  }

  public async getObjectUrl(input: ObjectKeyInput): Promise<string> {
    return this.getStorageService().getObjectUrl(input);
  }

  public async objectExists(input: ObjectKeyInput): Promise<boolean> {
    return this.getStorageService().objectExists(input);
  }

  private getStorageService(): StorageService {
    this.storageService ??= createStorageServiceFromEnv();
    return this.storageService;
  }
}

export const createDeferredStorageServiceFromEnv = (): StorageService =>
  new DeferredStorageService();

export const isStorageConfigured = (): boolean =>
  Boolean(env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);
