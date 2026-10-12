import { getSession } from "@/lib/auth";
import { chemicalImportTemplate } from "@/modules/chemicals/bulk-service";

export async function GET() {
  const actor = await getSession();
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (!actor) return new Response(null, { status: 401, headers });
  try {
    const body = await chemicalImportTemplate(actor);
    return new Response(new Uint8Array(body), {
      headers: {
        ...headers,
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition":
          "attachment; filename=Pheno-SAM-Bulk-Upload-Template.xlsx",
      },
    });
  } catch {
    return new Response(null, { status: 404, headers });
  }
}
