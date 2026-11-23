import { getSession } from "@/lib/auth";
import { requireStudies } from "@/modules/film-studies/access";
import { AuthorizationError } from "@/modules/authorization/policy";
import { StudyError } from "@/modules/film-studies/schema";
import { ZodError } from "zod";
export const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
export async function portalActor(req: Request, write: boolean) {
  const user = await getSession();
  if (!user) throw new AuthorizationError();
  await requireStudies(user);
  if (write) {
    const origin = req.headers.get("origin");
    if (
      !origin ||
      new URL(origin).host !==
        (req.headers.get("host") ?? new URL(req.url).host) ||
      req.headers.get("sec-fetch-site") === "cross-site"
    )
      throw new AuthorizationError();
  }
  return user;
}
export function failure(e: unknown) {
  const code =
    e instanceof AuthorizationError
      ? "access"
      : e instanceof StudyError
        ? e.code
        : e instanceof ZodError || e instanceof SyntaxError
          ? "invalid"
          : "unavailable";
  const status = {
    access: 403,
    invalid: 400,
    missing: 404,
    conflict: 409,
    incomplete: 409,
    unavailable: 503,
  }[code];
  return Response.json({ error: code }, { status, headers: privateHeaders });
}
export async function boundedBody(req: Request, limit: number) {
  if (Number(req.headers.get("content-length")) > limit || !req.body)
    throw new StudyError("invalid");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const s = await reader.read();
      if (s.done) break;
      length += s.value.length;
      if (length > limit) {
        await reader.cancel();
        throw new StudyError("invalid");
      }
      chunks.push(s.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}
