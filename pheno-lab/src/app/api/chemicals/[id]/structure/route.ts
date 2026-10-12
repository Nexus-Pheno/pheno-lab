import { getSession } from "@/lib/auth";
import { readChemicalStructure } from "@/modules/chemicals/service";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getSession();
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  };
  if (!actor) return new Response(null, { status: 401, headers });
  try {
    const { id } = await params;
    const body = await readChemicalStructure(actor, id);
    return body
      ? new Response(Buffer.from(body), {
          headers: { ...headers, "Content-Type": "image/svg+xml" },
        })
      : new Response(null, { status: 404, headers });
  } catch {
    return new Response(null, { status: 404, headers });
  }
}
