import { getSession } from "@/lib/auth";
import { readImportedWorkbook } from "@/modules/chemicals/bulk-service";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getSession();
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (!actor) return new Response(null, { status: 401, headers });
  try {
    const body = await readImportedWorkbook(actor, (await params).id);
    if (!body) return new Response(null, { status: 404, headers });
    return new Response(new Uint8Array(body), {
      headers: {
        ...headers,
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition":
          "attachment; filename=Pheno-SAM-Uploaded-Workbook.xlsx",
      },
    });
  } catch {
    return new Response(null, { status: 404, headers });
  }
}
