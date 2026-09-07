import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/infrastructure/db/client";
import { serverConfig } from "@/infrastructure/config/server";
import { sendDingTalkText } from "@/infrastructure/push/dingtalk";
import { log } from "@/infrastructure/logging/logger";
import { championPce, digestWindow } from "./digest";

export async function runMorningDigest(
  now = new Date(),
): Promise<"disabled" | "skipped" | "sent" | "failed"> {
  try {
    const config = serverConfig();
    if (!config.DINGTALK_WEBHOOK_URL || !config.DINGTALK_ORGANIZATION_SLUG)
      return "disabled";
    const organization = await db.organization.findFirst({
      where: { slug: config.DINGTALK_ORGANIZATION_SLUG, status: "ACTIVE" },
      select: { id: true },
    });
    if (!organization) return "disabled";
    const { date, start, end } = digestWindow(now);
    const where = { organizationId: organization.id };
    const attemptId = `dingtalk-digest-${createHash("sha256").update(`${organization.id}:${date}`).digest("hex")}`;
    if (
      await db.auditEvent.findUnique({
        where: { id: attemptId },
        select: { id: true },
      })
    )
      return "skipped";
    const [
      completionEvents,
      measurements,
      registrations,
      access,
      materialEdits,
      recipes,
      unmatched,
    ] = await Promise.all([
      db.auditEvent.findMany({
        where: {
          ...where,
          entityType: "Experiment",
          createdAt: { gte: start, lt: end },
          action: {
            in: [
              "experiment.approve",
              "experiment.complete-from-capture",
              "experiment.update",
            ],
          },
          changes: { path: ["status"], equals: "COMPLETE" },
        },
        distinct: ["entityId"],
        select: { entityId: true },
      }),
      db.jvMeasurement.findMany({
        where: {
          ...where,
          status: "MATCHED",
          condition: "LIGHT",
          measuredAt: { gte: start, lt: end },
          experiment: { organizationId: organization.id, isTest: false },
        },
        select: { metrics: true },
      }),
      db.user.count({ where: { ...where, pendingApproval: true } }),
      db.accessRequest.count({
        where: { status: "open", experiment: { ...where, isTest: false } },
      }),
      db.materialEditSuggestion.count({
        where: { ...where, status: "PENDING" },
      }),
      db.recipe.count({
        where: { ...where, approvalStatus: "PENDING", archived: false },
      }),
      db.jvMeasurement.count({ where: { ...where, status: "UNMATCHED" } }),
    ]);
    const completed = await db.experiment.count({
      where: {
        ...where,
        isTest: false,
        id: { in: completionEvents.map((event) => event.entityId) },
      },
    });
    const champion = championPce(measurements);
    const content = `早间摘要 ${date}（北京时间）\n昨日完成实验：${completed}\n昨日最高有效光照扫描 PCE：${champion === null ? "暂无有效数据" : `${champion.toFixed(2)}%`}\n待审批注册：${registrations}\n待处理访问申请：${access}\n待审批材料修改：${materialEdits}\n待审批配方：${recipes}\n未匹配扫描：${unmatched}\n请登录 Pheno Lab 查看授权范围内的详情。`;
    try {
      await db.auditEvent.create({
        data: {
          id: attemptId,
          ...where,
          actorType: "SYSTEM",
          action: "notifications.digest.attempted",
          entityType: "Organization",
          entityId: organization.id,
          metadata: { date },
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        return "skipped";
      throw error;
    }
    const sent = await sendDingTalkText(content);
    await db.auditEvent.create({
      data: {
        ...where,
        actorType: "SYSTEM",
        action: sent
          ? "notifications.digest.sent"
          : "notifications.digest.failed",
        entityType: "Organization",
        entityId: organization.id,
        metadata: { date },
      },
    });
    return sent ? "sent" : "failed";
  } catch {
    log.warn("dingtalk.digest_failed", { reason: "digest_unavailable" });
    return "failed";
  }
}
