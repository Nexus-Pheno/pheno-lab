import { describe, expect, it } from "vitest";
import { imageUploadSchema, MAX_IMAGE_SIZE } from "./schema";

describe("imageUploadSchema", () => {
  it("accepts supported images", () => {
    expect(
      imageUploadSchema.safeParse(
        new File([new Uint8Array([1, 2, 3])], "photo.png", {
          type: "image/png",
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects executable content and oversized images", () => {
    expect(
      imageUploadSchema.safeParse(
        new File(["binary"], "payload.exe", {
          type: "application/octet-stream",
        }),
      ).success,
    ).toBe(false);
    expect(
      imageUploadSchema.safeParse(
        new File([new Uint8Array(MAX_IMAGE_SIZE + 1)], "large.jpg", {
          type: "image/jpeg",
        }),
      ).success,
    ).toBe(false);
  });
});
