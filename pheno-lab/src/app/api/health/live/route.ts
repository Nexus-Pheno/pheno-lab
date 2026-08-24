import { healthRequestId, livenessPayload } from "@/modules/health/service";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const requestId = healthRequestId(request.headers.get("x-request-id"));
  return Response.json(livenessPayload(requestId), {
    headers: {
      "Cache-Control": "no-store",
      "X-Request-ID": requestId,
    },
  });
}
