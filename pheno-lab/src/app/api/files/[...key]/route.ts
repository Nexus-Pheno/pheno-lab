import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { readObject } from "@/modules/files/service";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { key: segments } = await params;
  const key = segments.join("/");
  try {
    const object = await readObject(session, key);
    if (!object)
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    return new NextResponse(new Uint8Array(object.body), {
      headers: {
        "Content-Type": object.contentType,
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
