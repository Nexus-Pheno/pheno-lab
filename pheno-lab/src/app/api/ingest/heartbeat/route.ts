import { NextRequest, NextResponse } from "next/server";
import { authenticateInstrumentToken } from "@/modules/instruments/authentication-service";
import { heartbeatSchema } from "@/modules/instruments/schema";
import { updateInstrumentHeartbeat } from "@/modules/instruments/heartbeat-service";

/** `pheno-bridge.exe test` calls this to prove the key and the route work. */
export async function GET(req: NextRequest) {
  const token = (req.headers.get("authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  const instrument = await authenticateInstrumentToken(token);
  if (!instrument)
    return NextResponse.json(
      { error: "Unknown or inactive instrument key" },
      { status: 401 },
    );
  return NextResponse.json({
    ok: true,
    instrument: instrument.name,
    kind: instrument.kind,
  });
}

/** Liveness ping, so the platform can show "小太阳 — last seen 2 min ago". */
export async function POST(req: NextRequest) {
  const token = (req.headers.get("authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  const instrument = await authenticateInstrumentToken(token);
  if (!instrument)
    return NextResponse.json(
      { error: "Unknown or inactive instrument key" },
      { status: 401 },
    );

  const parsed = heartbeatSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid heartbeat payload" },
      { status: 400 },
    );
  }
  await updateInstrumentHeartbeat(instrument, parsed.data);
  return NextResponse.json({ ok: true });
}
