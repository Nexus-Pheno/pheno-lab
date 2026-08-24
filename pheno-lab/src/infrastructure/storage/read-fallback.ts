import "server-only";

import type { ObjectStorage, PutObjectInput, StorageHealth } from "./types";

/**
 * Migration-only adapter: all new writes go to the primary store, while reads
 * fall back to the retained local directory until migration is verified.
 */
export class ReadFallbackObjectStorage implements ObjectStorage {
  constructor(
    private readonly primary: ObjectStorage,
    private readonly fallback: ObjectStorage,
  ) {}

  put(input: PutObjectInput): Promise<void> {
    return this.primary.put(input);
  }

  async get(key: string): Promise<Uint8Array | null> {
    return (await this.primary.get(key)) ?? this.fallback.get(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.primary.exists(key)) || this.fallback.exists(key);
  }

  delete(key: string): Promise<void> {
    // The retained local copy is a read-only rollback source. Ordinary app
    // deletes must never remove it during migration.
    return this.primary.delete(key);
  }

  health(): Promise<StorageHealth> {
    return this.primary.health();
  }
}
