import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { nanoid } from "nanoid";

const CORRELATION_HEADER = "x-correlation-id";

export function middleware(request: NextRequest) {
  const correlationId =
    request.headers.get(CORRELATION_HEADER) ?? nanoid(16);

  // Clone request headers to inject correlation ID
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(CORRELATION_HEADER, correlationId);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  response.headers.set(CORRELATION_HEADER, correlationId);

  return response;
}

export const config = {
  matcher: "/api/:path*",
};
