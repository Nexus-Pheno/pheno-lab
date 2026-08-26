import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

function sessionSecret(): Uint8Array {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error("SESSION_SECRET is missing or shorter than 32 characters");
  }
  return new TextEncoder().encode(value);
}

function requestId(request: NextRequest): string {
  const provided = request.headers.get("x-request-id")?.trim();
  return provided && /^[A-Za-z0-9._:-]{1,128}$/.test(provided)
    ? provided
    : crypto.randomUUID();
}

function continueRequest(request: NextRequest, id: string): NextResponse {
  const headers = new Headers(request.headers);
  headers.set("x-request-id", id);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("x-request-id", id);
  return response;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const id = requestId(req);
  if (
    pathname === "/login" ||
    pathname === "/register" ||
    pathname === "/onboard" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/sw.js" ||
    pathname === "/api/health/live" ||
    pathname === "/api/health/ready"
  ) {
    return continueRequest(req, id);
  }

  // Instrument agents authenticate with a bearer API key, not a session cookie.
  if (pathname.startsWith("/api/ingest/")) return continueRequest(req, id);

  const token = req.cookies.get("pheno_session")?.value;
  if (token) {
    try {
      await jwtVerify(token, sessionSecret());
      return continueRequest(req, id);
    } catch {
      // Fall through to the login redirect. Every protected action still
      // performs its own session and authorization check server-side.
    }
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  const response = NextResponse.redirect(url);
  response.headers.set("x-request-id", id);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand).*)"],
};
