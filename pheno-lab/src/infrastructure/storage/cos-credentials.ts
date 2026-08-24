import "server-only";

export type CosCredentials = {
  secretId: string;
  secretKey: string;
  securityToken?: string;
  expiresAt?: number;
};

export interface CosCredentialProvider {
  get(): Promise<CosCredentials>;
}

export class StaticCosCredentialProvider implements CosCredentialProvider {
  constructor(private readonly credentials: CosCredentials) {}

  async get(): Promise<CosCredentials> {
    return this.credentials;
  }
}

type MetadataCredential = {
  Code?: string;
  TmpSecretId?: string;
  TmpSecretKey?: string;
  Token?: string;
  ExpiredTime?: number;
};

const ROLE_ENDPOINT =
  "http://metadata.tencentyun.com/latest/meta-data/cam/security-credentials/";
const REFRESH_BUFFER_SECONDS = 60;

/**
 * Reads rotating STS credentials from the CVM metadata service. The endpoint
 * is fixed to Tencent metadata, requests time out quickly, and credentials are
 * cached only until shortly before expiry.
 */
export class CvmRoleCosCredentialProvider implements CosCredentialProvider {
  private cached?: CosCredentials;
  private inFlight?: Promise<CosCredentials>;

  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<CosCredentials> {
    if (
      this.cached?.expiresAt &&
      this.cached.expiresAt - REFRESH_BUFFER_SECONDS > this.now() / 1_000
    ) {
      return this.cached;
    }
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = undefined;
    });
    this.cached = await this.inFlight;
    return this.cached;
  }

  private async load(): Promise<CosCredentials> {
    const roleResponse = await this.request(ROLE_ENDPOINT, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!roleResponse.ok) {
      throw new Error("Unable to read the CAM role from CVM metadata.");
    }
    const role = (await roleResponse.text()).trim();
    if (!/^[A-Za-z0-9+=,.@_-]{1,128}$/.test(role)) {
      throw new Error("CVM metadata returned an invalid CAM role name.");
    }

    const credentialResponse = await this.request(
      ROLE_ENDPOINT + encodeURIComponent(role),
      { signal: AbortSignal.timeout(2_000) },
    );
    if (!credentialResponse.ok) {
      throw new Error(
        "Unable to read temporary credentials from CVM metadata.",
      );
    }
    const body = (await credentialResponse.json()) as MetadataCredential;
    if (
      body.Code !== "Success" ||
      !body.TmpSecretId ||
      !body.TmpSecretKey ||
      !body.Token ||
      !body.ExpiredTime
    ) {
      throw new Error("CVM metadata returned incomplete COS credentials.");
    }
    return {
      secretId: body.TmpSecretId,
      secretKey: body.TmpSecretKey,
      securityToken: body.Token,
      expiresAt: body.ExpiredTime,
    };
  }
}
