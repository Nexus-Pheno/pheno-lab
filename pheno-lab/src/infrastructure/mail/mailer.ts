import "server-only";

import nodemailer from "nodemailer";
import { serverConfig } from "@/infrastructure/config/server";

// SMTP is configured entirely via the environment. When it is disabled,
// pending OTP codes remain available only to administrators in the Users page.
export function isMailConfigured() {
  const config = serverConfig();
  return Boolean(config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS);
}

export async function sendMail(
  to: string,
  subject: string,
  text: string,
  html?: string,
) {
  if (!isMailConfigured()) throw new Error("SMTP is not configured.");
  const config = serverConfig();
  const port = config.SMTP_PORT;
  const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
  });
  await transporter.sendMail({
    from: config.SMTP_FROM ?? config.SMTP_USER,
    to,
    subject,
    text,
    html,
  });
}

export function otpEmail(code: string) {
  const subject = `${code} — Pheno Lab registration code / 注册验证码`;
  const text =
    `Your Pheno Lab Data Platform registration code is: ${code}\n` +
    `It is valid for 15 minutes.\n\n` +
    `您的 Pheno 实验数据平台注册验证码为：${code}\n有效期 15 分钟。\n\n` +
    `If you did not request this, you can ignore this email. / 如非本人操作，请忽略此邮件。`;
  const html = `
  <div style="font-family:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;max-width:420px;margin:0 auto;padding:24px">
    <div style="font-size:14px;font-weight:700;color:#1a1c16;margin-bottom:16px">Pheno Lab Data Platform</div>
    <p style="font-size:13px;color:#3d4037;margin:0 0 6px">Your registration code / 注册验证码：</p>
    <div style="font-family:'Roboto Mono',ui-monospace,monospace;font-size:28px;font-weight:700;letter-spacing:6px;color:#1a1c16;background:#f4f6ef;border:1px solid #e3e6dc;border-radius:6px;padding:14px 18px;text-align:center;margin:10px 0 14px">${code}</div>
    <p style="font-size:12px;color:#6b6f64;margin:0">Valid for 15 minutes / 有效期 15 分钟。<br/>If you did not request this, ignore this email. / 如非本人操作，请忽略此邮件。</p>
  </div>`;
  return { subject, text, html };
}
