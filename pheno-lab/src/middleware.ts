import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === "/login" || pathname === "/register" || pathname === "/onboard") return NextResponse.next();
  // Instrument agents authenticate with a bearer API key, not a session cookie.
  if (pathname.startsWith("/api/ingest/")) return NextResponse.next();

  const token = req.cookies.get("pheno_session")?.value;
  if (token) {
    try {
      await jwtVerify(token, new TextEncoder().encode(process.env.SESSION_SECRET!));
      return NextResponse.next();
    } catch {
      // fall through to redirect
    }
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand|.*\\.png$).*)"],
};
