import { createHash } from "node:crypto";

export const reportDigest = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

/** Inline assets only; even an authorized report has no app-origin privileges. */
export function reportContentSecurityPolicy(html: string): string {
  const hashes = (tag: "style" | "script") =>
    [
      ...html.matchAll(
        new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"),
      ),
    ]
      .map(
        (match) =>
          `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`,
      )
      .join(" ");
  return [
    "default-src 'none'",
    `style-src ${hashes("style") || "'none'"}`,
    `script-src ${hashes("script") || "'none'"}`,
    "img-src data:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    "sandbox allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox",
  ].join("; ");
}
