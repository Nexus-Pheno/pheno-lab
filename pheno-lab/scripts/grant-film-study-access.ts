import { readFileSync } from "node:fs";
import { z } from "zod";
import { db } from "../src/infrastructure/db/client";
import { eligibleStudyAccount } from "../src/modules/film-studies/access";
import { recordSystemAudit } from "../src/modules/audit/writer";

// Operator-only. Pin selected identities, organization and the exact active key;
// refuse partial rosters and keep human access independent of the agent grant.
const identity = z.object({ name: z.string().min(1), email: z.email() });
const schema = z
  .object({
    organizationId: z.string().min(1),
    members: z.array(identity).min(1).max(100),
    agentOwner: identity,
    agentKeyId: z.string().min(1),
    agentKeyLabel: z.string().min(1),
  })
  .strict();
async function main() {
  const v = schema.parse(JSON.parse(readFileSync(0, "utf8")));
  const apply = process.argv[2] === "--apply";
  if (!apply && process.argv[2] !== "--check")
    throw Error("Choose --check or --apply");
  if (new Set(v.members.map((m) => m.email)).size !== v.members.length)
    throw Error("Duplicate member");
  const result = await db.$transaction(
    async (tx) => {
      const where = {
        ...eligibleStudyAccount,
        organizationId: v.organizationId,
      };
      const users = await tx.user.findMany({
        where: { ...where, OR: v.members },
        select: { id: true, filmStudyAccess: true },
      });
      if (users.length !== v.members.length)
        throw Error("Verify the selected members");
      const owner = await tx.user.findFirstOrThrow({
        where: { ...where, ...v.agentOwner, role: "ADMIN" },
        select: { id: true, filmStudyAgentAccess: true, sessionVersion: true },
      });
      const key = await tx.researchReaderKey.findFirstOrThrow({
        where: {
          id: v.agentKeyId,
          userId: owner.id,
          organizationId: v.organizationId,
          sessionVersion: owner.sessionVersion,
          label: v.agentKeyLabel,
          expiresAt: { gt: new Date() },
          revokedAt: null,
        },
        select: { id: true, filmStudies: true },
      });
      const changed = users.filter((u) => !u.filmStudyAccess);
      if (apply) {
        for (const u of changed) {
          await tx.user.update({
            where: { id: u.id },
            data: { filmStudyAccess: true },
          });
          await recordSystemAudit(tx, {
            organizationId: v.organizationId,
            action: "filmStudy.access.granted",
            entityType: "User",
            entityId: u.id,
          });
        }
        if (!owner.filmStudyAgentAccess) {
          await tx.user.update({
            where: { id: owner.id },
            data: { filmStudyAgentAccess: true },
          });
          await recordSystemAudit(tx, {
            organizationId: v.organizationId,
            action: "filmStudy.agentOwner.granted",
            entityType: "User",
            entityId: owner.id,
          });
        }
        if (!key.filmStudies) {
          await tx.researchReaderKey.update({
            where: { id: key.id },
            data: { filmStudies: true },
          });
          await recordSystemAudit(tx, {
            organizationId: v.organizationId,
            action: "filmStudy.reader.granted",
            entityType: "ResearchReaderKey",
            entityId: key.id,
          });
        }
      }
      return {
        apply,
        eligibleMembers: users.length,
        memberChanges: changed.length,
        readerChange: !key.filmStudies,
        ownerChange: !owner.filmStudyAgentAccess,
      };
    },
    { isolationLevel: "Serializable" },
  );
  console.log(JSON.stringify(result));
}
main()
  .catch(() => {
    console.error(
      "Characterization grants failed; verify exact active accounts, key, and organization.",
    );
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
