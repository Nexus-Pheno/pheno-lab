import { describe, expect, it } from "vitest";
import { reportContentSecurityPolicy } from "@/modules/reports/html";
import { publishReportSchema } from "@/modules/reports/schema";

describe("report isolation", () => {
  it("allows exact inline assets without app origin, external resources or inline event handlers", () => {
    const csp = reportContentSecurityPolicy(
      "<style>body{color:red}</style><script>print();</script>",
    );
    expect(csp).toContain("script-src 'sha256-");
    expect(csp).toContain("style-src 'sha256-");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|allow-same-origin/);
    expect(reportContentSecurityPolicy("<html></html>")).toContain(
      "script-src 'none'",
    );
  });
  it("rejects fragments, empty recipients and oversized titles", () => {
    const input = {
      organizationId: "test",
      publicationKey: "test-v1",
      titleEn: "Report",
      titleZh: "报告",
      generatedAt: new Date(),
      html: "<!DOCTYPE html><html><body>Complete document content</body></html>",
      recipientIds: ["manager"],
      authorizationReference: "Approved test",
    };
    expect(publishReportSchema.safeParse(input).success).toBe(true);
    for (const change of [
      { html: "<body>fragment</body>" },
      { recipientIds: [] },
      { titleEn: "x".repeat(201) },
    ])
      expect(
        publishReportSchema.safeParse({ ...input, ...change }).success,
      ).toBe(false);
  });
});
