import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { db as prisma } from "@/lib/db";
import { authenticateInstrument } from "@/lib/instruments/auth";
import { parseInstrumentFile, UnsupportedInstrumentFile } from "@/lib/instruments";
import { matchSerial, normalizeSerial, refreshSampleJvResult } from "@/lib/instruments/match";
import { scanKeyOf } from "@/lib/instruments/scan-key";

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const RAW_DIR = path.join(UPLOAD_DIR, "instruments");
const MAX_SIZE = 25 * 1024 * 1024;
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png"]);

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

/**
 * Receives one file from a pheno-bridge agent. The raw bytes are always kept —
 * parsing is deliberately re-runnable, so a parser fix can be replayed over
 * history without touching the lab PCs.
 */
export async function POST(req: NextRequest) {
  const instrument = await authenticateInstrument(req);
  if (!instrument) {
    return NextResponse.json({ status: "rejected", message: "Unknown or inactive instrument key" }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ status: "rejected", message: "No file in the request" }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ status: "rejected", message: "File is larger than 25 MB" }, { status: 413 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const fileName = (field(form, "fileName") || file.name || "upload").slice(0, 300);
  const sourcePath = field(form, "sourcePath").slice(0, 500);
  const sourceDir = field(form, "sourceDir").slice(0, 500);
  const modifiedRaw = field(form, "modifiedAt");
  const modifiedAt = modifiedRaw && !Number.isNaN(Date.parse(modifiedRaw)) ? new Date(modifiedRaw) : null;
  const ext = path.extname(fileName).toLowerCase();
  const base = path.basename(fileName, path.extname(fileName));

  // The agent retries whole batches, so the same bytes legitimately arrive twice.
  const seen = await prisma.instrumentUpload.findUnique({
    where: { instrumentId_sha256: { instrumentId: instrument.id, sha256 } },
    select: { id: true, status: true, message: true },
  });
  if (seen) {
    return NextResponse.json(
      { status: "duplicate", message: "Already received this file", scans: 0 },
      { status: 409 },
    );
  }

  // ── images: the screenshot GiantForce saves beside each CSV ───────────────
  if (IMAGE_EXT.has(ext)) {
    const storedName = `${sha256}${ext === ".jpeg" ? ".jpg" : ext}`;
    await mkdir(UPLOAD_DIR, { recursive: true });
    await writeFile(path.join(UPLOAD_DIR, storedName), buf);
    await prisma.instrumentUpload.create({
      data: {
        instrumentId: instrument.id,
        fileName,
        sourcePath,
        storedPath: storedName,
        sha256,
        size: buf.length,
        mime: file.type || "image/jpeg",
        modifiedAt,
        status: "ATTACHMENT",
        message: "",
      },
    });
    // Attach to scans from the same-named CSV, whichever arrived first.
    const linked = await prisma.jvMeasurement.updateMany({
      where: { instrumentId: instrument.id, imagePath: null, upload: { fileName: { startsWith: base } } },
      data: { imagePath: storedName },
    });
    return NextResponse.json({
      status: "stored",
      scans: 0,
      message: linked.count ? `Attached to ${linked.count} scan(s)` : "Stored; no matching scan yet",
    });
  }

  // ── data files ────────────────────────────────────────────────────────────
  const storedRel = path.join("instruments", instrument.id, `${sha256}${ext || ".csv"}`);
  await mkdir(path.join(RAW_DIR, instrument.id), { recursive: true });
  await writeFile(path.join(UPLOAD_DIR, storedRel), buf);

  const uploadBase = {
    instrumentId: instrument.id,
    fileName,
    sourcePath,
    storedPath: storedRel,
    sha256,
    size: buf.length,
    mime: file.type || "text/csv",
    modifiedAt,
  };

  let parsed;
  try {
    parsed = parseInstrumentFile(buf, {
      fileName,
      sourceDir,
      fileModifiedAt: modifiedAt ?? undefined,
      instrument: instrument.kind,
    });
  } catch (e) {
    const message = e instanceof UnsupportedInstrumentFile ? e.message : `Could not read this file: ${(e as Error).message}`;
    await prisma.instrumentUpload.create({ data: { ...uploadBase, status: "REJECTED", message } });
    // 422 tells the agent not to keep retrying this file.
    return NextResponse.json({ status: "rejected", message, scans: 0 }, { status: 422 });
  }

  const upload = await prisma.instrumentUpload.create({
    data: { ...uploadBase, status: "PARSED", message: parsed.warnings.join(" ") },
  });

  // An image for this basename may already be waiting.
  const priorImage = await prisma.instrumentUpload.findFirst({
    where: { instrumentId: instrument.id, status: "ATTACHMENT", fileName: { startsWith: base } },
    orderBy: { receivedAt: "desc" },
    select: { storedPath: true },
  });

  const touchedSamples = new Set<string>();
  const notes: string[] = [];
  let duplicateScans = 0;
  for (const scan of parsed.scans) {
    // The LIGHTSKY rig re-saves earlier traces in every session file, so the
    // same physical scan legitimately arrives inside different files.
    const scanKey = scanKeyOf(scan);
    const already = await prisma.jvMeasurement.findUnique({
      where: { instrumentId_scanKey: { instrumentId: instrument.id, scanKey } },
      select: { id: true },
    });
    if (already) {
      duplicateScans++;
      continue;
    }

    const match = await matchSerial(instrument.organizationId, scan.serial);
    await prisma.jvMeasurement.create({
      data: {
        organizationId: instrument.organizationId,
        instrumentId: instrument.id,
        uploadId: upload.id,
        serial: scan.serial,
        serialKey: normalizeSerial(scan.serial),
        scanKey,
        direction: scan.direction,
        condition: scan.condition,
        measuredAt: scan.measuredAt,
        operator: scan.operator,
        material: scan.material,
        metrics: scan.metrics as object,
        curve: scan.curve as object,
        settings: scan.settings as object,
        imagePath: priorImage?.storedPath ?? null,
        experimentId: match.experimentId,
        sampleId: match.sampleId,
        runId: match.runId,
        status: match.status,
        matchNote: match.matchNote,
      },
    });
    if (match.sampleId) touchedSamples.add(match.sampleId);
    else notes.push(match.matchNote);
  }

  for (const sampleId of touchedSamples) {
    const outcome = await refreshSampleJvResult(sampleId);
    if (outcome === "no-card") notes.push("Matched, but the experiment has no J-V characterization card to fill.");
    if (outcome === "kept-manual") notes.push("Matched; kept the value a technician had already typed in.");
  }

  const matched = touchedSamples.size;
  const newScans = parsed.scans.length - duplicateScans;
  if (duplicateScans) {
    notes.push(`${duplicateScans} scan(s) were already recorded from an earlier file.`);
  }
  return NextResponse.json({
    status: matched ? "stored" : newScans === 0 ? "duplicate" : "unmatched",
    scans: newScans,
    message: [...parsed.warnings, ...new Set(notes)].join(" ").slice(0, 500),
  });
}
