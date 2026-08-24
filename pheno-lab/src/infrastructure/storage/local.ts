import "server-only";

import {
  access,
  mkdir,
  readFile,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { normalizeObjectKey } from "./key";
import type { ObjectStorage, PutObjectInput, StorageHealth } from "./types";

export class LocalObjectStorage implements ObjectStorage {
  constructor(private readonly root: string) {}

  private filePath(key: string): string {
    const normalized = normalizeObjectKey(key);
    const target = path.resolve(this.root, ...normalized.split("/"));
    const resolvedRoot = path.resolve(this.root);
    if (!target.startsWith(`${resolvedRoot}${path.sep}`))
      throw new Error("Invalid object key");
    return target;
  }

  async put(input: PutObjectInput): Promise<void> {
    const target = this.filePath(input.key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.body, { flag: "w" });
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.filePath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.filePath(key));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.filePath(key), { force: true });
  }

  async health(): Promise<StorageHealth> {
    await mkdir(this.root, { recursive: true });
    await access(this.root, constants.R_OK | constants.W_OK);
    const disk = await statfs(this.root);
    return {
      driver: "local",
      writable: true,
      availableBytes: disk.bavail * disk.bsize,
    };
  }
}
