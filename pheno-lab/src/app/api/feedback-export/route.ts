import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { exportFeedback } from "@/modules/accounts/query";

// Full JSON export of feedback for handing to agents: message, reporter,
// page, user agent, error logs, screenshot references, timestamps.
export async function GET() {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }
  const feedback = await exportFeedback(session);
  return new NextResponse(JSON.stringify(feedback, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": 'attachment; filename="pheno-feedback.json"',
    },
  });
}
