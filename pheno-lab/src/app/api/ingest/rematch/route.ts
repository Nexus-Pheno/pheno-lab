import { NextRequest, NextResponse } from "next/server";
import {
  authorizeRematch,
  rematchEveryOrganization,
} from "@/modules/instruments/rematch-service";

/**
 * Scheduled sweep: retries every measurement that could not be matched when it
 * arrived. Scans regularly land before the experiment that explains them
 * exists, so matching has to be retried rather than attempted once.
 *
 * Run it from cron on the server:
 *   * /10 * * * *  curl -fsS -H "Authorization: Bearer $INGEST_CRON_SECRET" \
 *                       https://<host>/api/ingest/rematch -X POST
 */
export async function POST(req: NextRequest) {
  const token = (req.headers.get("authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  const authorization = authorizeRematch(token);
  if (authorization === "unconfigured") {
    return NextResponse.json(
      { error: "INGEST_CRON_SECRET is not configured" },
      { status: 503 },
    );
  }
  if (authorization === "denied") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results = await rematchEveryOrganization();
  return NextResponse.json({ ok: true, results });
}
