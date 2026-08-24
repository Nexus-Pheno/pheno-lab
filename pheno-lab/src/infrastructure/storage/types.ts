export type PutObjectInput = {
  key: string;
  body: Uint8Array;
  contentType: string;
  sha256?: string;
};

export type StorageHealth = {
  driver: "local" | "cos";
  writable: boolean;
  availableBytes?: number;
};

export interface ObjectStorage {
  put(input: PutObjectInput): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  health(): Promise<StorageHealth>;
}
