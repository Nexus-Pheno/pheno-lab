import { describe, expect, it } from "vitest";
import {
  documentUploadSchema,
  imageUploadSchema,
  MAX_DOCUMENT_SIZE,
  MAX_IMAGE_SIZE,
  storedDocumentSchema,
} from "./schema";

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

describe("documentUploadSchema", () => {
  it("accepts a vendor spec sheet", () => {
    expect(
      documentUploadSchema.safeParse(
        new File([new Uint8Array([1, 2, 3])], "规格书.pdf", {
          type: "application/pdf",
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects executables and oversized documents", () => {
    expect(
      documentUploadSchema.safeParse(
        new File(["binary"], "payload.exe", {
          type: "application/octet-stream",
        }),
      ).success,
    ).toBe(false);
    expect(
      documentUploadSchema.safeParse(
        new File([new Uint8Array(MAX_DOCUMENT_SIZE + 1)], "huge.pdf", {
          type: "application/pdf",
        }),
      ).success,
    ).toBe(false);
  });

  it("does not accept an image through the document path", () => {
    expect(
      documentUploadSchema.safeParse(
        new File([new Uint8Array([1])], "photo.png", { type: "image/png" }),
      ).success,
    ).toBe(false);
  });
});

describe("storedDocumentSchema", () => {
  it("keeps the original file name and stored key", () => {
    const parsed = storedDocumentSchema.parse({
      fileName: "MiniFlex600 manual.pdf",
      storedPath: "organizations/org1/users/u1/documents/2026/08/abc.pdf",
      mime: "application/pdf",
      size: 2048,
    });
    expect(parsed.fileName).toBe("MiniFlex600 manual.pdf");
    expect(parsed.size).toBe(2048);
  });

  it("rejects a reference with no stored key", () => {
    expect(
      storedDocumentSchema.safeParse({ fileName: "a.pdf", storedPath: "" })
        .success,
    ).toBe(false);
  });
});
