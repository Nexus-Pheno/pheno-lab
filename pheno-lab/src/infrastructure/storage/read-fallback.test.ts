import { describe, expect, it, vi } from "vitest";
import { ReadFallbackObjectStorage } from "./read-fallback";
import type { ObjectStorage } from "./types";

function fake(overrides: Partial<ObjectStorage> = {}): ObjectStorage {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    exists: vi.fn().mockResolvedValue(false),
    delete: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ driver: "cos", writable: true }),
    ...overrides,
  };
}

describe("ReadFallbackObjectStorage", () => {
  it("writes only to primary and falls back only when an object is missing", async () => {
    const fallback = fake({
      get: vi.fn().mockResolvedValue(Buffer.from("legacy")),
      exists: vi.fn().mockResolvedValue(true),
    });
    const primary = fake();
    const storage = new ReadFallbackObjectStorage(primary, fallback);

    await storage.put({
      key: "new/file.txt",
      body: Buffer.from("new"),
      contentType: "text/plain",
    });
    expect(primary.put).toHaveBeenCalledOnce();
    expect(fallback.put).not.toHaveBeenCalled();
    await expect(storage.get("legacy/file.txt")).resolves.toEqual(
      Buffer.from("legacy"),
    );
    await expect(storage.exists("legacy/file.txt")).resolves.toBe(true);
  });

  it("never deletes from the retained fallback", async () => {
    const primary = fake();
    const fallback = fake();
    const storage = new ReadFallbackObjectStorage(primary, fallback);
    await storage.delete("old/file.txt");
    expect(primary.delete).toHaveBeenCalledOnce();
    expect(fallback.delete).not.toHaveBeenCalled();
  });
});
