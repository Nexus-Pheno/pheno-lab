/** Read-only operator check. Does not invoke the publisher or create an access event. */
import fs from "node:fs/promises";
import { z } from "zod";
import { db } from "../../src/infrastructure/db/client";
import { objectStorage } from "../../src/infrastructure/storage";
import { reportDigest } from "../../src/modules/reports/html";

const enrollment = z
  .object({
    organizationId: z.string().min(1),
    recipients: z
      .array(
        z.object({ id: z.string().min(1), email: z.string().email() }).strict(),
      )
      .length(5),
  })
  .strict();
const sameMembers = (left: string[], right: string[]) =>
  JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

async function main() {
  const [rosterFile, publicationKey] = process.argv.slice(2);
  if (!/^[a-z0-9][a-z0-9-]{2,119}$/.test(publicationKey ?? "")) throw Error();
  const roster = enrollment.parse(
    JSON.parse(await fs.readFile(rosterFile, "utf8")),
  );
  const ids = roster.recipients.map((user) => user.id);
  if (
    new Set(ids).size !== 5 ||
    new Set(roster.recipients.map((x) => x.email)).size !== 5
  )
    throw Error();
  const org = roster.organizationId;
  const result = await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const users = await tx.user.findMany({
        where: {
          organizationId: org,
          organization: { status: "ACTIVE" },
          id: { in: ids },
          active: true,
          pendingApproval: false,
          mustChangePassword: false,
          testingOnly: false,
          reportAccess: true,
        },
        select: { id: true, email: true },
      });
      if (
        !roster.recipients.every((x) =>
          users.some((u) => u.id === x.id && u.email === x.email),
        )
      )
        throw Error();
      const row = await tx.labReport.findUnique({
        where: {
          organizationId_publicationKey: {
            organizationId: org,
            publicationKey,
          },
        },
      });
      if (!row)
        return {
          status: "ABSENT",
          organizationId: org,
          recipientIds: ids.sort(),
        };
      if (
        !sameMembers(row.recipientIds, ids) ||
        !row.storedPath.startsWith(`organizations/${org}/reports/`)
      )
        throw Error();
      const notices = await tx.notification.findMany({
        where: {
          organizationId: org,
          kind: "report_published",
          href: `/reports/${row.id}`,
        },
        select: { id: true, userId: true },
      });
      const audits = await tx.auditEvent.findMany({
        where: {
          organizationId: org,
          action: "report.published",
          entityType: "LabReport",
          entityId: row.id,
        },
        select: { id: true, metadata: true },
      });
      if (
        audits.length !== 1 ||
        !sameMembers(
          notices.map((n) => n.userId),
          ids,
        )
      )
        throw Error();
      const meta = z
        .object({
          contentSha256: z.string(),
          contentBytes: z.number(),
          notifiedRecipients: z.literal(5),
        })
        .parse(audits[0].metadata);
      if (
        meta.contentSha256 !== row.contentSha256 ||
        meta.contentBytes !== row.contentBytes
      )
        throw Error();
      return {
        status: "PUBLISHED",
        organizationId: org,
        recipientIds: ids.sort(),
        reportId: row.id,
        publicationKey,
        titleEn: row.titleEn,
        titleZh: row.titleZh,
        generatedAt: row.generatedAt,
        publishedAt: row.publishedAt,
        contentSha256: row.contentSha256,
        contentBytes: row.contentBytes,
        storedPath: row.storedPath,
        auditId: audits[0].id,
        noticeIds: notices.map((n) => n.id).sort(),
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
  if (result.storedPath) {
    const bytes = await objectStorage().get(result.storedPath);
    if (
      !bytes ||
      bytes.byteLength !== result.contentBytes ||
      reportDigest(bytes) !== result.contentSha256
    )
      throw Error();
  }
  const { storedPath: _privatePath, ...receipt } = result;
  void _privatePath;
  console.log(JSON.stringify(receipt));
}

main()
  .catch(() => {
    console.error(
      "Weekly report recipient, publication, audit, or storage check failed.",
    );
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
