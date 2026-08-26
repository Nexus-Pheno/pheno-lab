import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { documentUploadSchema, imageUploadSchema } from "@/modules/files/schema";
import { storeDocument, storeImage } from "@/modules/files/service";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }
  const form = await req.formData();
  const file = form.get("file");

  // Images stay the default so existing callers keep their contract; documents
  // are opt-in and return the metadata a business record needs to store.
  if (form.get("kind") === "document") {
    const parsed = documentUploadSchema.safeParse(file);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "No file" },
        { status: 400 },
      );
    }
    return NextResponse.json(await storeDocument(session, parsed.data));
  }

  const parsed = imageUploadSchema.safeParse(file);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "No file" },
      { status: 400 },
    );
  }
  return NextResponse.json({
    fileName: await storeImage(session, parsed.data),
  });
}
