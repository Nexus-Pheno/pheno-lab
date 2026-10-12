import "server-only";

import { db } from "@/infrastructure/db/client";
import { serverConfig } from "@/infrastructure/config/server";
import { sendDingTalkText } from "@/infrastructure/push/dingtalk";
import { log } from "@/infrastructure/logging/logger";

const messages = {
  testing_requested:
    "有新的 JV 测试需求，请测试专员登录 Pheno Lab 测试工作台查看基底编码与图片。",
  access_requested: "有新的实验访问申请，请负责人登录 Pheno Lab 处理。",
  assigned: "有新的实验任务分配，请登录 Pheno Lab 查看。",
  registration_pending: "有新注册申请等待管理员审批，请登录 Pheno Lab 处理。",
  material_edit_requested:
    "有材料修改建议等待负责人审批，请登录 Pheno Lab 处理。",
  recipe_approval_requested: "有新配方等待负责人审批，请登录 Pheno Lab 处理。",
} as const;

export async function sendGroupNotice(
  organizationId: string,
  kind: keyof typeof messages,
): Promise<boolean> {
  try {
    const config = serverConfig();
    if (
      !config.DINGTALK_ORGANIZATION_SLUG ||
      (!config.DINGTALK_WEBHOOK_URL &&
        !(kind === "testing_requested" && config.DINGTALK_JV_WEBHOOK_URL))
    )
      return false;
    const organization = await db.organization.findFirst({
      where: {
        id: organizationId,
        slug: config.DINGTALK_ORGANIZATION_SLUG,
        status: "ACTIVE",
      },
      select: { id: true },
    });
    if (!organization) return false;
    const deliveries: Promise<boolean>[] = [];
    if (config.DINGTALK_WEBHOOK_URL)
      deliveries.push(sendDingTalkText(messages[kind]));
    if (kind === "testing_requested" && config.DINGTALK_JV_WEBHOOK_URL)
      deliveries.push(sendDingTalkText(messages[kind], "jv-testing"));
    // One destination's failure must not suppress the other post-commit alert.
    const results = await Promise.allSettled(deliveries);
    return results.some(
      (result) => result.status === "fulfilled" && result.value,
    );
  } catch {
    log.warn("dingtalk.notice_failed", { reason: "delivery_unavailable" });
    return false;
  }
}
