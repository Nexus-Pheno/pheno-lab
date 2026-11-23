import "server-only";
import { db } from "@/infrastructure/db/client";
import type { Actor } from "@/modules/authorization/actor";
import { requireStudies } from "./access";
import { studyInfo } from "./service";
import { methods, searchMethods } from "./methods";
export async function listPublishedStudies(
  org: string,
  limit: number,
  after?: string,
  q?: string,
) {
  const match = q ? { contains: q, mode: "insensitive" as const } : undefined;
  const rows = await db.filmStudy.findMany({
    where: {
      organizationId: org,
      publishedAt: { not: null },
      ...(after ? { id: { gt: after } } : {}),
      ...(match
        ? {
            OR: [
              { id: q },
              { notes: match },
              { customMethod: match },
              { method: { in: searchMethods(q!).map((m) => m.code) } },
              { materials: { some: { name: match } } },
              { files: { some: { name: match } } },
            ],
          }
        : {}),
    },
    select: studyInfo,
    orderBy: { id: "asc" },
    take: limit,
  });
  return rows.map((row) => {
    const m = methods.find((m) => m.code === row.method);
    return {
      ...row,
      methodNameEn: row.customMethod || m?.en,
      methodNameZh: row.customMethod || m?.zh,
    };
  });
}
export async function portalData(actor: Actor, page: number) {
  await requireStudies(actor);
  const where = { organizationId: actor.org, publishedAt: { not: null } };
  const [materials, records, total, drafts] = await Promise.all([
    db.material.findMany({
      where: { organizationId: actor.org, archived: false },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.filmStudy.findMany({
      where,
      select: studyInfo,
      orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * 20,
      take: 20,
    }),
    db.filmStudy.count({ where }),
    db.filmStudy.findMany({
      where: {
        organizationId: actor.org,
        authorId: actor.uid,
        publishedAt: null,
      },
      select: studyInfo,
      orderBy: { createdAt: "desc" },
    }),
  ]);
  return { materials, records, total, drafts };
}
