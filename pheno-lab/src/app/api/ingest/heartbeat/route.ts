import { NextRequest, NextResponse } from "next/server";
import { db as prisma } from "@/lib/db";
import { authenticateInstrument } from "@/lib/instruments/auth";

/** `pheno-bridge.exe test` calls this to prove the key and the route work. */
export async function GET(req: NextRequest) {
  const instrument = await authenticateInstrument(req);
  if (!instrument) return NextResponse.json({ error: "Unknown or inactive instrument key" }, { status: 401 });
  return NextResponse.json({ ok: true, instrument: instrument.name, kind: instrument.kind });
}

/** Liveness ping, so the platform can show "小太阳 — last seen 2 min ago". */
export async function POST(req: NextRequest) {
  const instrument = await authenticateInstrument(req);
  if (!instrument) return NextResponse.json({ error: "Unknown or inactive instrument key" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  await prisma.instrument.update({
    where: { id: instrument.id },
    data: {
      lastSeenAt: new Date(),
      hostname: String(body.hostname ?? "").slice(0, 200),
      agentVersion: String(body.agentVersion ?? "").slice(0, 40),
      lastError: String(body.lastError ?? "").slice(0, 500),
      watchDirs: Array.isArray(body.watchDirs) ? body.watchDirs.map((d: unknown) => String(d).slice(0, 400)) : [],
    },
  });
  return NextResponse.json({ ok: true });
}
