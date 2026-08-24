import {
  healthRequestId,
  isHealthcheckAuthorized,
  notReadyPayload,
  readinessPayload,
} from "@/modules/health/service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = healthRequestId(request.headers.get("x-request-id"));
  const headers = { "Cache-Control": "no-store", "X-Request-ID": requestId };
  if (!isHealthcheckAuthorized(request.headers.get("authorization"))) {
    return Response.json(
      { status: "unauthorized", requestId },
      { status: 401, headers },
    );
  }
  try {
    return Response.json(await readinessPayload(requestId), { headers });
  } catch {
    return Response.json(notReadyPayload(requestId), {
      status: 503,
      headers,
    });
  }
}
