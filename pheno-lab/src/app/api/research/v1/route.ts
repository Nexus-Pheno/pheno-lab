import { authenticateReader } from "@/modules/research-reader/access";
import {
  parseReaderRequest,
  readResearch,
} from "@/modules/research-reader/query";
import { AuthorizationError } from "@/modules/authorization/policy";
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  Vary: "Authorization",
};
export async function GET(request: Request) {
  try {
    const reader = await authenticateReader(
      request.headers.get("authorization"),
    );
    if (!reader)
      return Response.json(
        { error: "A valid research reader key is required." },
        { status: 401, headers: { ...headers, "WWW-Authenticate": "Bearer" } },
      );
    const input = parseReaderRequest(new URL(request.url).searchParams);
    if (!input)
      return Response.json(
        { error: "Invalid research query." },
        { status: 400, headers },
      );
    const result = await readResearch(reader, input);
    return result
      ? Response.json(result, { headers })
      : Response.json(
          { error: "Record unavailable." },
          { status: 404, headers },
        );
  } catch (error) {
    const denied = error instanceof AuthorizationError;
    return Response.json(
      {
        error: denied ? "Permission denied." : "Read temporarily unavailable.",
      },
      { status: denied ? 403 : 503, headers },
    );
  }
}
