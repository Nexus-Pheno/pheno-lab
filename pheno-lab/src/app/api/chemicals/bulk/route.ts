import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";
import { requireChemicalAccess } from "@/modules/chemicals/query";
import { AuthorizationError } from "@/modules/authorization/policy";
import {
  ChemicalImportConflict,
  ChemicalWorkbookError,
  importChemicalWorkbook,
  previewChemicalImport,
  MAX_CHEMICAL_FILE_BYTES,
  MAX_CHEMICAL_REVIEW_BYTES,
} from "@/modules/chemicals/bulk-service";

const controlSchema = z.object({
  mode: z.enum(["preview", "import"]),
  category: z.string().trim().min(1).max(100).default("SAM"),
  batchId: z.uuid().optional(),
  expectedDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  expectedReviewDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export async function POST(request: Request) {
  const actor = await getSession();
  if (!actor)
    return Response.json(
      { ok: false, error: "access" },
      { status: 401, headers },
    );
  try {
    await requireChemicalAccess(actor);
    const origin = request.headers.get("origin");
    if (
      !origin ||
      new URL(origin).host !==
        (request.headers.get("host") ?? new URL(request.url).host) ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      return Response.json(
        { ok: false, error: "access" },
        { status: 403, headers },
      );
    const maxBody = MAX_CHEMICAL_FILE_BYTES + MAX_CHEMICAL_REVIEW_BYTES + 65536;
    if (
      Number(request.headers.get("content-length")) > maxBody ||
      !request.headers.get("content-type")?.startsWith("multipart/form-data") ||
      !request.body
    )
      throw new ChemicalWorkbookError("file");
    const reader = request.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBody) {
        await reader.cancel();
        throw new ChemicalWorkbookError("file");
      }
      chunks.push(part.value);
    }
    const form = await new Response(Buffer.concat(chunks), {
      headers: { "Content-Type": request.headers.get("content-type")! },
    }).formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size > MAX_CHEMICAL_FILE_BYTES)
      throw new ChemicalWorkbookError("file");
    const control = controlSchema.parse({
      mode: form.get("mode"),
      category: form.get("category") ?? undefined,
      batchId: form.get("batchId") ?? undefined,
      expectedDigest: form.get("expectedDigest") ?? undefined,
      expectedReviewDigest: form.get("expectedReviewDigest") ?? undefined,
    });
    const rawReview = form.get("review");
    let review: unknown;
    if (rawReview !== null) {
      if (
        typeof rawReview !== "string" ||
        Buffer.byteLength(rawReview) > MAX_CHEMICAL_REVIEW_BYTES
      )
        throw new ChemicalWorkbookError("file");
      try {
        review = JSON.parse(rawReview);
      } catch {
        throw new ChemicalWorkbookError("file");
      }
    }
    const input = {
      filename: file.name,
      category: control.category,
      review,
      bytes: new Uint8Array(await file.arrayBuffer()),
    };
    if (control.mode === "preview")
      return Response.json(
        { ok: true, preview: await previewChemicalImport(actor, input) },
        { headers },
      );
    const result = await importChemicalWorkbook(actor, {
      ...input,
      batchId: control.batchId,
      expectedDigest: control.expectedDigest,
      expectedReviewDigest: control.expectedReviewDigest,
    });
    revalidatePath("/chemicals");
    revalidatePath("/library");
    return Response.json({ ok: true, result }, { headers });
  } catch (error) {
    const code =
      error instanceof AuthorizationError
        ? "access"
        : error instanceof ChemicalWorkbookError
          ? error.code
          : error instanceof ChemicalImportConflict
            ? "conflict"
            : error instanceof z.ZodError
              ? "file"
              : "failed";
    return Response.json(
      { ok: false, error: code },
      {
        status:
          code === "access"
            ? 404
            : code === "failed"
              ? 500
              : code === "conflict"
                ? 409
                : 400,
        headers,
      },
    );
  }
}
