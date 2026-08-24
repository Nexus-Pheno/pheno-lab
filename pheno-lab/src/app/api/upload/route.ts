import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { imageUploadSchema } from "@/modules/files/schema";
import { storeImage } from "@/modules/files/service";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }
  const form = await req.formData();
  const parsed = imageUploadSchema.safeParse(form.get("file"));
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
