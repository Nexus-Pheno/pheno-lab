import { describe, expect, it, vi } from "vitest";
import { StaticCosCredentialProvider } from "./cos-credentials";
import { CosObjectStorage } from "./cos";

function setup() {
  const client = {
    putObject: vi.fn().mockResolvedValue({}),
    getObject: vi.fn().mockResolvedValue({ Body: Buffer.from("payload") }),
    headObject: vi.fn().mockResolvedValue({}),
    deleteObject: vi.fn().mockResolvedValue({}),
    headBucket: vi.fn().mockResolvedValue({}),
  };
  const storage = new CosObjectStorage(
    "ap-guangzhou",
    "pheno-files-1250000000",
    new StaticCosCredentialProvider({
      secretId: "id",
      secretKey: "key",
    }),
    () => client as never,
  );
  return { client, storage };
}

describe("CosObjectStorage", () => {
  it("keeps objects private and stores the supplied checksum as metadata", async () => {
    const { client, storage } = setup();
    await storage.put({
      key: "organizations/org-1/files/result.csv",
      body: Buffer.from("payload"),
      contentType: "text/csv",
      sha256: "abc123",
    });

    expect(client.putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: "pheno-files-1250000000",
        Region: "ap-guangzhou",
        Key: "organizations/org-1/files/result.csv",
        ACL: "private",
        ContentType: "text/csv",
        "x-cos-meta-sha256": "abc123",
      }),
    );
  });

  it("returns bytes and maps COS 404 responses to missing objects", async () => {
    const { client, storage } = setup();
    await expect(storage.get("a/file.txt")).resolves.toEqual(
      new Uint8Array(Buffer.from("payload")),
    );

    client.getObject.mockRejectedValueOnce({ statusCode: 404 });
    client.headObject.mockRejectedValueOnce({ code: "NoSuchKey" });
    await expect(storage.get("missing/file.txt")).resolves.toBeNull();
    await expect(storage.exists("missing/file.txt")).resolves.toBe(false);
  });

  it("checks bucket reachability without writing a probe object", async () => {
    const { client, storage } = setup();
    await expect(storage.health()).resolves.toEqual({
      driver: "cos",
      writable: true,
    });
    expect(client.headBucket).toHaveBeenCalledWith({
      Bucket: "pheno-files-1250000000",
      Region: "ap-guangzhou",
    });
    expect(client.putObject).not.toHaveBeenCalled();
  });
});
