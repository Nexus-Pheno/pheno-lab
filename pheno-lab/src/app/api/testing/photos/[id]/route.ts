import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { readTestingPhoto } from "@/modules/testing/service";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession("testing");
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const object = await readTestingPhoto(session, (await params).id);
    if (!object)
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    return new NextResponse(new Uint8Array(object.body), {
      headers: {
        "Content-Type": object.contentType,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
