import { NextRequest, NextResponse } from "next/server";
import { authenticateInstrumentToken } from "@/modules/instruments/authentication-service";
import {
  ingestInstrumentUpload,
  type InstrumentUploadInput,
} from "@/modules/instruments/ingest-service";
import {
  instrumentUploadMetadataSchema,
  MAX_INSTRUMENT_FILE_SIZE,
} from "@/modules/instruments/schema";

const field = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

export async function POST(request: NextRequest) {
  const token = (request.headers.get("authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  const instrument = await authenticateInstrumentToken(token);
  if (!instrument) {
    return NextResponse.json(
      { status: "rejected", message: "Unknown or inactive instrument key" },
      { status: 401 },
    );
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { status: "rejected", message: "No file in the request" },
      { status: 400 },
    );
  }
  if (file.size > MAX_INSTRUMENT_FILE_SIZE) {
    return NextResponse.json(
      { status: "rejected", message: "File is larger than 25 MB" },
      { status: 413 },
    );
  }

  const metadata = instrumentUploadMetadataSchema.safeParse({
    fileName: field(form, "fileName") || file.name || "upload",
    sourcePath: field(form, "sourcePath"),
    sourceDir: field(form, "sourceDir"),
    modifiedAt: field(form, "modifiedAt") || undefined,
    mime: file.type,
  });
  if (!metadata.success) {
    return NextResponse.json(
      {
        status: "rejected",
        message: metadata.error.issues[0]?.message ?? "Invalid upload metadata",
      },
      { status: 400 },
    );
  }

  const input: InstrumentUploadInput = {
    ...metadata.data,
    body: Buffer.from(await file.arrayBuffer()),
  };
  const response = await ingestInstrumentUpload(instrument, input);
  return NextResponse.json(response.body, { status: response.statusCode });
}
