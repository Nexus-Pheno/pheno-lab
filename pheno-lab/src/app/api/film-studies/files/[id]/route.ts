import {
  findStudyFile,
  readStudyPart,
  savePart,
} from "@/modules/film-studies/service";
import {
  PART_BYTES,
  partCount,
  StudyError,
} from "@/modules/film-studies/schema";
import { boundedBody, portalActor, failure, privateHeaders } from "../../http";
type Context = { params: Promise<{ id: string }> };
export async function PUT(req: Request, ctx: Context) {
  try {
    const actor = await portalActor(req, true);
    const { id } = await ctx.params;
    const raw = new URL(req.url).searchParams.get("part");
    if (!raw || !/^\d{1,4}$/.test(raw)) throw new StudyError("invalid");
    await savePart(actor, id, Number(raw), await boundedBody(req, PART_BYTES));
    return new Response(null, { status: 204, headers: privateHeaders });
  } catch (e) {
    return failure(e);
  }
}
export async function GET(req: Request, ctx: Context) {
  try {
    const actor = await portalActor(req, false);
    const { id } = await ctx.params;
    const file = await findStudyFile(actor.org, id);
    if (!file) throw new StudyError("missing");
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index === partCount(file.size)) {
          controller.close();
          return;
        }
        try {
          const part = await readStudyPart(actor.org, file, index++);
          controller.enqueue(part.bytes);
        } catch (e) {
          controller.error(e);
        }
      },
    });
    return new Response(stream, {
      headers: {
        ...privateHeaders,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(file.size),
        "Content-Disposition":
          "attachment; filename*=UTF-8''" +
          encodeURIComponent(file.name).replace(
            /['()*]/g,
            (c) => "%" + c.charCodeAt(0).toString(16),
          ),
      },
    });
  } catch (e) {
    return failure(e);
  }
}
