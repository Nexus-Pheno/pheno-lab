import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";

// Full JSON export of feedback for handing to agents: message, reporter,
// page, user agent, error logs, screenshot references, timestamps.
export async function GET() {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }
  const feedback = await db.feedback.findMany({
    where: { organizationId: session.org },
    orderBy: { createdAt: "desc" },
    include: { user: { select: { name: true, email: true, role: true } } },
  });
  return new NextResponse(JSON.stringify(feedback, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": 'attachment; filename="pheno-feedback.json"',
    },
  });
}
