import "server-only";

import COS from "cos-nodejs-sdk-v5";
import { normalizeObjectKey } from "./key";
import type { CosCredentialProvider, CosCredentials } from "./cos-credentials";
import type { ObjectStorage, PutObjectInput, StorageHealth } from "./types";

type CosClient = Pick<
  COS,
  "putObject" | "getObject" | "headObject" | "deleteObject" | "headBucket"
>;
type CosClientFactory = (credentials: CosCredentials) => CosClient;

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; statusCode?: number };
  return (
    candidate.statusCode === 404 ||
    candidate.code === "NoSuchKey" ||
    candidate.code === "NotFound"
  );
}

const defaultClientFactory: CosClientFactory = (credentials) =>
  new COS({
    SecretId: credentials.secretId,
    SecretKey: credentials.secretKey,
    SecurityToken: credentials.securityToken,
    Protocol: "https:",
    Timeout: 5_000,
    KeepAlive: true,
  });

export class CosObjectStorage implements ObjectStorage {
  constructor(
    private readonly region: string,
    private readonly bucket: string,
    private readonly credentials: CosCredentialProvider,
    private readonly createClient: CosClientFactory = defaultClientFactory,
  ) {}

  private async client(): Promise<CosClient> {
    return this.createClient(await this.credentials.get());
  }

  private object(key: string) {
    return {
      Bucket: this.bucket,
      Region: this.region,
      Key: normalizeObjectKey(key),
    };
  }

  async put(input: PutObjectInput): Promise<void> {
    const client = await this.client();
    await client.putObject({
      ...this.object(input.key),
      Body: Buffer.from(input.body),
      ContentLength: input.body.byteLength,
      ContentType: input.contentType,
      ACL: "private",
      ...(input.sha256 ? { "x-cos-meta-sha256": input.sha256 } : {}),
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const client = await this.client();
      const result = await client.getObject(this.object(key));
      return new Uint8Array(result.Body);
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const client = await this.client();
      await client.headObject(this.object(key));
      return true;
    } catch (error) {
      if (isMissingObject(error)) return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const client = await this.client();
      await client.deleteObject(this.object(key));
    } catch (error) {
      if (!isMissingObject(error)) throw error;
    }
  }

  async health(): Promise<StorageHealth> {
    const client = await this.client();
    await client.headBucket({ Bucket: this.bucket, Region: this.region });
    return { driver: "cos", writable: true };
  }
}
