import { getSession } from "@/lib/auth";
import { exportChemicalDefinitions } from "@/modules/chemicals/query";

export async function GET() {
  const actor = await getSession();
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (!actor) return new Response(null, { status: 401, headers });
  try {
    const body = await exportChemicalDefinitions(actor);
    return Response.json(body, {
      headers: {
        ...headers,
        "Content-Disposition":
          "attachment; filename=pheno-private-chemistry.json",
      },
    });
  } catch {
    return new Response(null, { status: 404, headers });
  }
}
