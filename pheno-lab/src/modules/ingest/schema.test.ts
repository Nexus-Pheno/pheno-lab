import { describe, expect, it } from "vitest";
import {
  environmentDraftSchema,
  equipmentDraftSchema,
  parseIngestDraft,
} from "./schema";

const base = { name: "Rigaku XRD", processName: "XRD" };

describe("equipmentDraftSchema documents", () => {
  it("defaults to no documents so older staged items still parse", () => {
    expect(equipmentDraftSchema.parse(base).documents).toEqual([]);
  });

  it("keeps the stored key and original file name of each spec sheet", () => {
    const draft = equipmentDraftSchema.parse({
      ...base,
      documents: [
        {
          fileName: "MiniFlex600 规格书.pdf",
          storedPath: "organizations/org1/equipment/miniflex.pdf",
          mime: "application/pdf",
          size: 1024,
        },
      ],
    });
    expect(draft.documents).toEqual([
      {
        fileName: "MiniFlex600 规格书.pdf",
        storedPath: "organizations/org1/equipment/miniflex.pdf",
        mime: "application/pdf",
        size: 1024,
      },
    ]);
  });

  it("rejects a document reference with no stored key", () => {
    expect(
      equipmentDraftSchema.safeParse({
        ...base,
        documents: [{ fileName: "manual.pdf", storedPath: "" }],
      }).success,
    ).toBe(false);
  });

  it("reaches the same schema through parseIngestDraft", () => {
    const draft = parseIngestDraft("EQUIPMENT", {
      ...base,
      documents: [
        { fileName: "a.pdf", storedPath: "organizations/org1/a.pdf" },
      ],
    }) as { documents: { mime: string; size: number }[] };
    // mime/size are optional on the wire; the record still has usable defaults.
    expect(draft.documents[0]).toEqual({
      fileName: "a.pdf",
      storedPath: "organizations/org1/a.pdf",
      mime: "",
      size: 0,
    });
  });
});

describe("environmentDraftSchema documents", () => {
  it("defaults to no documents so older staged environments still parse", () => {
    const draft = environmentDraftSchema.parse({ name: "Glovebox N₂" });
    expect(draft.documents).toEqual([]);
    expect(draft.notes).toBe("");
  });

  it("carries the enclosure's manual and its detail text", () => {
    const draft = environmentDraftSchema.parse({
      name: "Glovebox N₂ (Mikrouna)",
      notes: "Mikrouna Inpure, three 2440 mm chambers.",
      documents: [
        {
          fileName: "手套箱-说明书.pdf",
          storedPath: "organizations/org1/documents/glovebox.pdf",
          mime: "application/pdf",
          size: 2048,
        },
      ],
    });
    expect(draft.notes).toContain("Mikrouna Inpure");
    expect(draft.documents[0].fileName).toBe("手套箱-说明书.pdf");
  });
});
