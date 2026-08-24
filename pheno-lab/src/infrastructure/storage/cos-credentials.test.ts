import { describe, expect, it, vi } from "vitest";
import { CvmRoleCosCredentialProvider } from "./cos-credentials";

describe("CvmRoleCosCredentialProvider", () => {
  it("loads and caches temporary credentials from the fixed metadata endpoint", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response("PhenoLabCosRole"))
      .mockResolvedValueOnce(
        Response.json({
          Code: "Success",
          TmpSecretId: "temporary-id",
          TmpSecretKey: "temporary-key",
          Token: "temporary-token",
          ExpiredTime: 2_000,
        }),
      );
    const provider = new CvmRoleCosCredentialProvider(
      request as unknown as typeof fetch,
      () => 1_000_000,
    );

    await expect(provider.get()).resolves.toMatchObject({
      secretId: "temporary-id",
      secretKey: "temporary-key",
      securityToken: "temporary-token",
    });
    await provider.get();

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toBe(
      "http://metadata.tencentyun.com/latest/meta-data/cam/security-credentials/",
    );
    expect(request.mock.calls[1][0]).toBe(
      "http://metadata.tencentyun.com/latest/meta-data/cam/security-credentials/PhenoLabCosRole",
    );
  });

  it("rejects unsafe role names instead of constructing a metadata URL", async () => {
    const request = vi.fn().mockResolvedValue(new Response("../escape"));
    const provider = new CvmRoleCosCredentialProvider(
      request as unknown as typeof fetch,
    );

    await expect(provider.get()).rejects.toThrow(/invalid CAM role/i);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
