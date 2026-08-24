import "server-only";

import { serverConfig } from "@/infrastructure/config/server";
import {
  CvmRoleCosCredentialProvider,
  StaticCosCredentialProvider,
} from "./cos-credentials";
import { CosObjectStorage } from "./cos";
import { LocalObjectStorage } from "./local";
import { ReadFallbackObjectStorage } from "./read-fallback";
import type { ObjectStorage } from "./types";

export type { ObjectStorage, PutObjectInput, StorageHealth } from "./types";

let instance: ObjectStorage | undefined;

export function objectStorage(): ObjectStorage {
  if (instance) return instance;
  const config = serverConfig();
  if (config.STORAGE_DRIVER === "local" && config.UPLOAD_DIR) {
    instance = new LocalObjectStorage(config.UPLOAD_DIR);
    return instance;
  }
  if (
    config.STORAGE_DRIVER === "cos" &&
    config.COS_REGION &&
    config.COS_FILES_BUCKET &&
    config.COS_AUTH_MODE
  ) {
    const credentials =
      config.COS_AUTH_MODE === "instance-role"
        ? new CvmRoleCosCredentialProvider()
        : new StaticCosCredentialProvider({
            secretId: config.COS_SECRET_ID!,
            secretKey: config.COS_SECRET_KEY!,
          });
    const cos = new CosObjectStorage(
      config.COS_REGION,
      config.COS_FILES_BUCKET,
      credentials,
    );
    instance = config.COS_LEGACY_UPLOAD_DIR
      ? new ReadFallbackObjectStorage(
          cos,
          new LocalObjectStorage(config.COS_LEGACY_UPLOAD_DIR),
        )
      : cos;
    return instance;
  }
  throw new Error(
    "Object storage configuration passed validation but no adapter could be created.",
  );
}
