import { z } from "zod";
import { beginStudy, finishStudy } from "@/modules/film-studies/service";
import { interpretNotes } from "@/modules/film-studies/interpretation";
import { StudyError } from "@/modules/film-studies/schema";
import { portalActor, boundedBody, failure, privateHeaders } from "./http";
export async function POST(request: Request) {
  try {
    const actor = await portalActor(request, true);
    const input = JSON.parse(
      (await boundedBody(request, 130000)).toString("utf8"),
    );
    if (input?.action === "start")
      return Response.json(await beginStudy(actor, input.data), {
        headers: privateHeaders,
      });
    const id = z.uuid().parse(input?.id);
    if (input.action === "finish") await finishStudy(actor, id);
    else if (input.action !== "interpret") throw new StudyError("invalid");
    // A later provider failure must not make a committed upload look lost.
    const interpreted =
      input.action === "finish"
        ? await interpretNotes(actor, id).catch(() => false)
        : await interpretNotes(actor, id);
    return Response.json(
      { saved: true, interpreted },
      { headers: privateHeaders },
    );
  } catch (e) {
    return failure(e);
  }
}
