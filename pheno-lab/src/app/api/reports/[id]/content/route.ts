import { getSession } from "@/lib/auth";
import { AuthorizationError } from "@/modules/authorization/policy";
import { readLabReportContent } from "@/modules/reports/service";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getSession();
  if (!actor)
    return new Response(null, { status: 404, headers: privateHeaders });
  try {
    const { id } = await params;
    const content = await readLabReportContent(actor, id);
    if (!content)
      return new Response(null, { status: 404, headers: privateHeaders });
    return new Response(Buffer.from(content.body), {
      headers: {
        ...privateHeaders,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": content.contentSecurityPolicy,
      },
    });
  } catch (error) {
    if (error instanceof AuthorizationError)
      return new Response(null, { status: 404, headers: privateHeaders });
    // Fail closed without disclosing storage details or report contents.
    return new Response(null, { status: 503, headers: privateHeaders });
  }
}
