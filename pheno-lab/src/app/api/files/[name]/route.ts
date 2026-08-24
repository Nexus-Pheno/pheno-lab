import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import { getSession } from "@/lib/auth";

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
};

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  if (!/^[a-zA-Z0-9-]+\.(jpg|png|webp|gif)$/.test(name)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    const buf = await readFile(path.join(UPLOAD_DIR, name));
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": MIME[path.extname(name)] ?? "application/octet-stream",
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
